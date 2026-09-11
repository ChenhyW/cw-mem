const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../lib/db');
const { runStopBatch, runSessionSummary, runVectorRetry, findSessionsNeedingSummary, runToolGroupSummary, _truncateToBytes } = require('../lib/batch');

function freshDb(dim = 4) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-batch-'));
  return { dir, ...openDb(dir, dim) };
}

// stub: llm.summarize 按 kind 返回 canned JSON
function makeLlmMod() {
  return {
    summarize: async ({ kind }) => {
      if (kind === 'tool') {
        return JSON.stringify({ title: '改了 ' + kind, type: 'change', concepts: ['what-changed'], filesChanged: ['a.js'], result: 'ok', sideEffect: '' });
      }
      if (kind === 'tool_batch') {
        return JSON.stringify({ title: '批量编辑', type: 'change', concepts: ['what-changed'], filesChanged: ['a.js','b.js'], result: '批量完成', sideEffect: '' });
      }
      if (kind === 'result') {
        return JSON.stringify({ request: '做某事', investigated: '看了 X', learned: '学到 Y', completed: '完成 Z', next_steps: '无', notes: '' });
      }
      if (kind === 'session') {
        return JSON.stringify({ request: '会话目标', investigated: '调研全程', learned: '沉淀 A', completed: '交付 B', next_steps: '跟进 C', notes: '' });
      }
      throw new Error('unknown kind ' + kind);
    },
    validateObservation: require('../lib/llm').validateObservation,
    setSummaryStatus: require('../lib/llm').setSummaryStatus,
    maxSummaryAttempts: require('../lib/llm').maxSummaryAttempts
  };
}

const fakeEmbed = async () => [[0.1, 0.2, 0.3, 0.4]];
const baseCfg = {
  llm: { enabled: true, apiKey: 'sk-x', model: 'm', apiBase: 'http://x', timeoutSeconds: 5, maxRetries: 3, retryIntervalSeconds: 1, summaryFieldLimit: 2000 },
  ollama: { url: 'http://x', embedModel: 'm', embedDim: 4 },
  toolSummary: { enabled: true, skipMode: 'on', payloadMaxBytes: 524288 },
  recall: { topK: 5, minCosine: 0, injectMaxCount: 8, injectMaxTokens: 800 },
  queue: { pollMs: 50, quiescenceSeconds: 0.05, toolGroupMax: 6, sweepIntervalSeconds: 60, spool: { enabled: false } }
};

test('runStopBatch reads pre-seeded tool summaries into the result template', async () => {
  const { db } = freshDb();
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, prompt, response, created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(1, 's1', 'cp1', '/p', 'PROMPT', '做某事', 'final response text', '2026-09-03T00:00:00Z');
  // 预置已摘要的 TOOL 行(runToolGroupSummary 的产物), 含一行损坏 meta 验证容错
  const seed = (id, meta) => db.prepare(
    "INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, tool_name, summary_status, summary_meta, vector_status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run(id, 's1', 'cp1', '/p', 'TOOL', 'Write', 'success', meta, 'success', '2026-09-03T00:00:0' + id + 'Z');
  seed(2, JSON.stringify({ title: '改了 a.js', type: 'change', concepts: [], filesChanged: ['a.js'], result: 'ok', sideEffect: '' }));
  seed(3, '{broken json');
  seed(4, JSON.stringify({ title: '改了 b.js', type: 'change', concepts: [], filesChanged: ['b.js'], result: 'ok', sideEffect: '' }));

  let resultFields = null;
  const llmMod = {
    ...makeLlmMod(),
    summarize: async (o) => { if (o.kind === 'result') resultFields = o.fields; return makeLlmMod().summarize(o); }
  };
  const r = await runStopBatch({ db, cfg: baseCfg, promptRowId: 1, llmMod, embedFn: fakeEmbed });
  assert.equal(r.status, 'success');

  // 两条有效工具观察进入 result 模板; 损坏行被跳过而非炸掉整个 result 摘要
  assert.ok(resultFields.tool_observations.includes('改了 a.js'), '预置工具观察应进入 result 模板');
  assert.ok(resultFields.tool_observations.includes('改了 b.js'));
  assert.ok(!resultFields.tool_observations.includes('broken'), '损坏 meta 应被跳过');
  // runStopBatch 只写 result 向量; TOOL 行由 Consumer 负责, 此处不触碰
  assert.equal(db.prepare("SELECT COUNT(*) c FROM memories_meta").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM memories_meta WHERE entity_type='tool'").get().c, 0);
});

test('runStopBatch toolObsText falls back to 无 when no tool summaries', async () => {
  const { db } = freshDb();
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, prompt, response, created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(1, 's1', 'cp1', '/p', 'PROMPT', '做某事', 'resp', '2026-09-03T00:00:00Z');

  let resultFields = null;
  const llmMod = {
    ...makeLlmMod(),
    summarize: async (o) => { if (o.kind === 'result') resultFields = o.fields; return makeLlmMod().summarize(o); }
  };
  const r = await runStopBatch({ db, cfg: baseCfg, promptRowId: 1, llmMod, embedFn: fakeEmbed });
  assert.equal(r.status, 'success', '无 tool 摘要也应能产出 result 摘要');
  assert.equal(resultFields.tool_observations, '无', '无工具观察时应回落为"无"');
});

test('runStopBatch invalid result json becomes retryable, not failed_final', async () => {
  const { db } = freshDb();
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, prompt, response, created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(1, 's1', 'cp1', '/p', 'PROMPT', '做某事', 'resp', '2026-09-03T00:00:00Z');
  const llmMod = { ...makeLlmMod(), summarize: async () => 'not json at all' };

  const r = await runStopBatch({ db, cfg: baseCfg, promptRowId: 1, llmMod, embedFn: fakeEmbed });
  assert.equal(r.status, 'failed');
  const p = db.prepare("SELECT summary_status, retry_attempts FROM prompts WHERE id=1").get();
  assert.notEqual(p.summary_status, 'failed_final', 'invalid json 是可重试的瞬时故障, 不应永久放弃');
  assert.equal(p.summary_status, 'failed_pending_retry');
});

test('runStopBatch keeps success status when vectorization fails', async () => {
  const { db } = freshDb();
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, prompt, response, created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(1, 's1', 'cp1', '/p', 'PROMPT', '做某事', 'resp', '2026-09-03T00:00:00Z');

  // 向量化全程抛错(模拟 ollama 超时/维度不匹配)
  const throwingEmbed = async () => { throw new Error('ollama timeout'); };
  const r = await runStopBatch({ db, cfg: baseCfg, promptRowId: 1, llmMod: makeLlmMod(), embedFn: throwingEmbed });
  assert.equal(r.status, 'success', '向量化失败不应判为失败(摘要已落库)');

  const p1 = db.prepare("SELECT summary_status, summary, vector_status, vector_error FROM prompts WHERE id=1").get();
  assert.equal(p1.summary_status, 'success', '摘要已成功, 向量化失败不应回退');
  assert.ok(p1.summary, '摘要内容应已落库');
  assert.equal(p1.vector_status, 'failed', '向量化失败应落 vector_status=failed');
  assert.ok(String(p1.vector_error).includes('ollama timeout'), '失败原因应落 vector_error');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM memories_meta").get().c, 0, '向量化全失败 → 无向量');
});

test('runStopBatch never re-summarizes tool rows (queue owns that)', async () => {
  const { db } = freshDb();
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, prompt, response, created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(1, 's1', 'cp1', '/p', 'PROMPT', '做某事', 'resp', '2026-09-03T00:00:00Z');
  // TOOL 行已 success: runStopBatch 不应重做, 也不应回退成 failed(历史回归 8e61236 的防护)
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, tool_name, prompt, summary_status, summary_meta, vector_status, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(2, 's1', 'cp1', '/p', 'TOOL', 'Bash', 'Bash: ls', 'success', '{"title":"已成功","type":"change","concepts":[],"filesChanged":[],"result":"ok"}', 'success', '2026-09-03T00:00:01Z');
  db.prepare("INSERT INTO tool_details(prompt_id, tool_use_id, tool_name, input_json, output_json, created_at) VALUES(?,?,?,?,?,?)")
    .run(2, 'tu1', 'Bash', '{"command":"ls"}', '{"stdout":"a"}', '2026-09-03T00:00:01Z');

  let toolCalls = 0;
  const base = makeLlmMod();
  const llmMod = {
    ...base,
    summarize: async ({ kind }) => {
      if (kind === 'tool' || kind === 'tool_batch') toolCalls++;
      return base.summarize({ kind });
    }
  };
  await runStopBatch({ db, cfg: baseCfg, promptRowId: 1, llmMod, embedFn: fakeEmbed });

  assert.equal(toolCalls, 0, 'runStopBatch 不应再发起任何工具摘要调用');
  const t2 = db.prepare("SELECT summary_status, summary_meta, vector_status FROM prompts WHERE id=2").get();
  assert.equal(t2.summary_status, 'success', '已成功工具状态不应被回退');
  assert.equal(JSON.parse(t2.summary_meta).title, '已成功', '原摘要内容不应被覆盖');
  assert.equal(t2.vector_status, 'success', '原向量化状态不应被改动');
});

test('runSessionSummary writes session_summaries row + 1 memory', async () => {
  const { db } = freshDb();
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  // a PROMPT with an existing result summary (for session summary input)
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, prompt, response, summary, summary_meta, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(1, 's1', 'cp1', '/p', 'PROMPT', '做某事', 'resp', '旧摘要文本', '{"request":"做某事","learned":"学到Y"}', '2026-09-03T00:00:00Z');

  const llmMod = makeLlmMod();
  await runSessionSummary({ db, cfg: baseCfg, sessionId: 's1', llmMod, embedFn: fakeEmbed });

  const ss = db.prepare("SELECT * FROM session_summaries WHERE session_id='s1'").get();
  assert.ok(ss, 'session_summaries row missing');
  assert.ok(ss.request);
  const memCount = db.prepare("SELECT COUNT(*) c FROM memories_meta WHERE entity_type='session'").get().c;
  assert.equal(memCount, 1);
});

test('runVectorRetry re-embeds failed/missing vectors for successful summaries', async () => {
  const { db } = freshDb();
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  // 摘要成功但向量失败的历史行(TOOL + PROMPT), summary_updated_at 设为 2 分钟前
  const old = new Date(Date.now() - 120000).toISOString();
  db.prepare("INSERT INTO prompts(id, session_id, project_dir, type, tool_name, summary_status, summary_meta, vector_status, vector_error, summary_updated_at, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(10, 's1', '/p', 'TOOL', 'Bash', 'success', '{"title":"t","action":"a","type":"change","concepts":[],"filesChanged":[],"result":"r"}', 'failed', 'old error', old, old);
  db.prepare("INSERT INTO prompts(id, session_id, project_dir, type, summary_status, summary_meta, vector_status, vector_error, summary_updated_at, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(11, 's1', '/p', 'PROMPT', 'success', '{"request":"rq","completed":"cp"}', 'failed', 'old error', old, old);
  // 刚摘要成功的行(1 分钟内)不应被补齐抢跑, 避免与实时向量化竞争
  const fresh = new Date().toISOString();
  db.prepare("INSERT INTO prompts(id, session_id, project_dir, type, summary_status, summary_meta, summary_updated_at, created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(12, 's1', '/p', 'PROMPT', 'success', '{"request":"fresh"}', fresh, fresh);

  const r = await runVectorRetry({ db, cfg: baseCfg, embedFn: fakeEmbed, limit: 20 });
  assert.equal(r.scanned, 2, '刚成功的行不在扫描范围');
  assert.equal(r.ok, 2);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM memories_meta").get().c, 2);
  assert.equal(db.prepare("SELECT vector_status FROM prompts WHERE id=10").get().vector_status, 'success');
  assert.equal(db.prepare("SELECT vector_status FROM prompts WHERE id=11").get().vector_status, 'success');
  assert.equal(db.prepare("SELECT vector_status FROM prompts WHERE id=12").get().vector_status, '', '1 分钟内的行不补齐');
});

// ─── session 摘要: 退出时不得产出空摘要 ─────────────────────────
// 复现: SessionEnd 时 result 摘要尚未落库 → 聚合输入为 '无' → LLM 按"无则填空"产出全空 JSON →
// 全空行被写入 session_summaries, 随后被 SessionStart 注入成 "### 过往会话" 下的空白条目。

const EMPTY_SESSION_JSON = JSON.stringify({ request: '', investigated: '', learned: '', completed: '', next_steps: '', notes: '' });

test('runSessionSummary skips when no result summaries exist yet', async () => {
  const { db } = freshDb();
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  // PROMPT 行已记录但 result 摘要还没生成(退出时 Stop 批量仍在跑)
  db.prepare("INSERT INTO prompts(id, session_id, project_dir, type, prompt, response, created_at) VALUES(?,?,?,?,?,?,?)")
    .run(1, 's1', '/p', 'PROMPT', '做某事', 'resp', '2026-09-03T00:00:00Z');

  let sessionCalls = 0;
  const llmMod = {
    ...makeLlmMod(),
    summarize: async ({ kind }) => {
      if (kind === 'session') { sessionCalls++; return EMPTY_SESSION_JSON; }
      return makeLlmMod().summarize({ kind });
    }
  };
  const r = await runSessionSummary({ db, cfg: baseCfg, sessionId: 's1', llmMod, embedFn: fakeEmbed });

  assert.equal(r.status, 'skipped', '无输入应跳过');
  assert.equal(sessionCalls, 0, '无输入不应调用 LLM');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM session_summaries').get().c, 0, '不应写入空摘要行');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM memories_meta WHERE entity_type='session'").get().c, 0, '不应写入空摘要向量');
});

test('runSessionSummary does not persist an all-empty LLM result', async () => {
  const { db } = freshDb();
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  db.prepare("INSERT INTO prompts(id, session_id, project_dir, type, summary_meta, created_at) VALUES(?,?,?,?,?,?)")
    .run(1, 's1', '/p', 'PROMPT', '{"request":"做某事"}', '2026-09-03T00:00:00Z');

  const llmMod = {
    ...makeLlmMod(),
    summarize: async ({ kind }) => (kind === 'session' ? EMPTY_SESSION_JSON : makeLlmMod().summarize({ kind }))
  };
  const r = await runSessionSummary({ db, cfg: baseCfg, sessionId: 's1', llmMod, embedFn: fakeEmbed });

  assert.equal(r.status, 'skipped', '全空结果应跳过');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM session_summaries').get().c, 0, '全空摘要不得落库');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM memories_meta WHERE entity_type='session'").get().c, 0, '全空摘要不得向量化');
});

test('runSessionSummary keeps one row per session (upsert, no orphaned vector)', async () => {
  const { db } = freshDb();
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  db.prepare("INSERT INTO prompts(id, session_id, project_dir, type, summary_meta, created_at) VALUES(?,?,?,?,?,?)")
    .run(1, 's1', '/p', 'PROMPT', '{"request":"做某事"}', '2026-09-03T00:00:00Z');

  const llmMod = makeLlmMod();
  await runSessionSummary({ db, cfg: baseCfg, sessionId: 's1', llmMod, embedFn: fakeEmbed });
  await runSessionSummary({ db, cfg: baseCfg, sessionId: 's1', llmMod, embedFn: fakeEmbed });

  assert.equal(db.prepare('SELECT COUNT(*) c FROM session_summaries').get().c, 1, '同一 session 只保留一份摘要');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM memories_meta WHERE entity_type='session'").get().c, 1, '不得留下孤儿向量');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM memories_vec').get().c, 1, 'memories_vec 也不得重复');
});

test('runSessionSummary keeps the row when vectorization fails', async () => {
  const { db } = freshDb();
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  db.prepare("INSERT INTO prompts(id, session_id, project_dir, type, summary_meta, created_at) VALUES(?,?,?,?,?,?)")
    .run(1, 's1', '/p', 'PROMPT', '{"request":"做某事"}', '2026-09-03T00:00:00Z');

  const throwingEmbed = async () => { throw new Error('ollama timeout'); };
  const r = await runSessionSummary({ db, cfg: baseCfg, sessionId: 's1', llmMod: makeLlmMod(), embedFn: throwingEmbed });

  assert.equal(r.status, 'success', '向量化失败不应判为失败(摘要已落库)');
  assert.ok(db.prepare("SELECT * FROM session_summaries WHERE session_id='s1'").get(), '摘要行应已落库');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM memories_meta WHERE entity_type='session'").get().c, 0);
});

test('findSessionsNeedingSummary picks only ended sessions with input and no summary', () => {
  const { db } = freshDb();
  const ins = (id, ended, hasSummary) => {
    db.prepare("INSERT INTO sessions(id, project_dir, ended_at) VALUES(?,?,?)").run(id, '/p', ended);
    if (hasSummary) {
      // prompts.id 不自填: 三次 hasSummary=true 的调用若都写死 id=1 会撞 PRIMARY KEY
      db.prepare("INSERT INTO prompts(session_id, project_dir, type, summary_meta, created_at) VALUES(?,?,?,?,?)")
        .run(id, '/p', 'PROMPT', '{"request":"x"}', '2026-09-03T00:00:00Z');
    }
  };
  ins('s-need', '2026-09-03T00:00:00Z', true);   // 应入选
  ins('s-open', null, true);                        // 未 ended, 不选
  ins('s-empty', '2026-09-03T00:01:00Z', false);   // 无 result 摘要, 不选
  ins('s-done', '2026-09-03T00:02:00Z', true);
  db.prepare("INSERT INTO session_summaries(session_id, created_at) VALUES(?,?)").run('s-done', '2026-09-03T00:03:00Z');

  const ids = findSessionsNeedingSummary(db, 10);
  assert.deepEqual(ids, ['s-need'], '只应选出 ended 且有输入且尚无摘要的 session');
});

// ─── 流式聚合: 一组 TOOL 行合并为一条 observation ─────────────
// 新架构下由 Consumer 调用, 签名显式接收行 id 列表(取代旧的内联 tool 阶段)。
test('runToolGroupSummary writes meta to first row, others success-no-meta, vectorizes first', async () => {
  const { db } = freshDb();
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  for (const id of [2, 3, 4]) {
    db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, tool_name, tool_target, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, 's1', 'cp1', '/p', 'TOOL', 'Write', 'Write /a.js', '2026-09-03T00:00:0' + id + 'Z');
    db.prepare("INSERT INTO tool_details(prompt_id, tool_name, input_json, output_json, created_at) VALUES (?,?,?,?,?)")
      .run(id, 'Write', '{"path":"/a.js"}', '{"ok":true}', '2026-09-03T00:00:0' + id + 'Z');
  }

  const r = await runToolGroupSummary({ db, cfg: baseCfg, toolRowIds: [2, 3, 4], llmMod: makeLlmMod(), embedFn: fakeEmbed });
  assert.equal(r.status, 'success');

  const first = db.prepare("SELECT summary_meta, summary_status, vector_status FROM prompts WHERE id=2").get();
  assert.ok(first.summary_meta, '首行应落 summary_meta');
  assert.equal(first.summary_status, 'success');
  assert.equal(first.vector_status, 'success', '首行应被向量化');
  for (const id of [3, 4]) {
    const row = db.prepare("SELECT summary_meta, summary_status, vector_status FROM prompts WHERE id=?").get(id);
    assert.equal(row.summary_status, 'success', '非首行标记 success');
    assert.ok(!row.summary_meta, '非首行不应落 meta');
    assert.equal(row.vector_status, '', '非首行不单独向量化');
  }
  // 只写 1 条 tool 向量
  assert.equal(db.prepare("SELECT COUNT(*) c FROM memories_meta WHERE entity_type='tool'").get().c, 1);
});

// 一张卡覆盖 N 次调用, 卡片必须能看出"N 次合并" —— count 落在首行 meta 上供 UI 渲染徽标。
// validateObservation 是字段白名单, 所以 count 只能由生产代码在校验之后补。
test('runToolGroupSummary records group size in summary_meta.count', async () => {
  const { db } = freshDb();
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  for (const id of [2, 3, 4]) {
    db.prepare("INSERT INTO prompts(id, session_id, project_dir, type, tool_name, tool_target, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, 's1', '/p', 'TOOL', 'Write', 'Write /a.js', '2026-09-03T00:00:0' + id + 'Z');
    db.prepare("INSERT INTO tool_details(prompt_id, tool_name, input_json, created_at) VALUES (?,?,?,?)")
      .run(id, 'Write', '{"path":"/a.js"}', '2026-09-03T00:00:0' + id + 'Z');
  }

  const r = await runToolGroupSummary({ db, cfg: baseCfg, toolRowIds: [2, 3, 4], llmMod: makeLlmMod(), embedFn: fakeEmbed });
  assert.equal(r.status, 'success');

  const meta = JSON.parse(db.prepare("SELECT summary_meta FROM prompts WHERE id=2").get().summary_meta);
  assert.equal(meta.count, 3, '首行 meta.count 应等于组内调用数');
});

test('runToolGroupSummary sets count=1 for a single-call group', async () => {
  const { db } = freshDb();
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  db.prepare("INSERT INTO prompts(id, session_id, project_dir, type, tool_name, tool_target, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(2, 's1', '/p', 'TOOL', 'Write', 'Write /a.js', '2026-09-03T00:00:02Z');
  db.prepare("INSERT INTO tool_details(prompt_id, tool_name, input_json, created_at) VALUES (?,?,?,?)")
    .run(2, 'Write', '{"path":"/a.js"}', '2026-09-03T00:00:02Z');

  const r = await runToolGroupSummary({ db, cfg: baseCfg, toolRowIds: [2], llmMod: makeLlmMod(), embedFn: fakeEmbed });
  assert.equal(r.status, 'success');

  const meta = JSON.parse(db.prepare("SELECT summary_meta FROM prompts WHERE id=2").get().summary_meta);
  assert.equal(meta.count, 1, '单调用组的 count 应为 1, UI 据此决定是否显示徽标');
});

test('runToolGroupSummary LLM failure marks retryable per row state machine', async () => {
  const { db } = freshDb();
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  for (const id of [2, 3]) {
    db.prepare("INSERT INTO prompts(id, session_id, project_dir, type, tool_name, tool_target, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, 's1', '/p', 'TOOL', 'Write', 'Write /a.js', '2026-09-03T00:00:0' + id + 'Z');
    db.prepare("INSERT INTO tool_details(prompt_id, tool_name, input_json, created_at) VALUES (?,?,?,?)")
      .run(id, 'Write', '{"path":"/a.js"}', '2026-09-03T00:00:0' + id + 'Z');
  }
  const llmMod = { ...makeLlmMod(), summarize: async () => { throw new Error('ollama down'); } };

  const r = await runToolGroupSummary({ db, cfg: baseCfg, toolRowIds: [2, 3], llmMod, embedFn: fakeEmbed });
  assert.equal(r.status, 'failed');
  assert.equal(r.retryable, true, 'maxRetries=3 首次失败应可重试');
  for (const id of [2, 3]) {
    const row = db.prepare("SELECT summary_status, retry_attempts, summary_meta FROM prompts WHERE id=?").get(id);
    assert.equal(row.summary_status, 'failed_pending_retry', '组内每行都应落可重试状态');
    assert.ok(!row.summary_meta, '失败不应落 meta');
  }
});

test('runToolGroupSummary invalid json is retryable, not permanent', async () => {
  const { db } = freshDb();
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  db.prepare("INSERT INTO prompts(id, session_id, project_dir, type, tool_name, tool_target, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(2, 's1', '/p', 'TOOL', 'Write', 'Write /a.js', '2026-09-03T00:00:02Z');
  db.prepare("INSERT INTO tool_details(prompt_id, tool_name, input_json, created_at) VALUES (?,?,?,?)")
    .run(2, 'Write', '{"path":"/a.js"}', '2026-09-03T00:00:02Z');
  const llmMod = { ...makeLlmMod(), summarize: async () => 'not json at all' };

  const r = await runToolGroupSummary({ db, cfg: baseCfg, toolRowIds: [2], llmMod, embedFn: fakeEmbed });
  assert.equal(r.status, 'failed');
  assert.equal(r.retryable, true);
  assert.equal(db.prepare("SELECT summary_status FROM prompts WHERE id=2").get().summary_status, 'failed_pending_retry');
});

test('runToolGroupSummary with empty id list is a no-op success', async () => {
  const { db } = freshDb();
  const r = await runToolGroupSummary({ db, cfg: baseCfg, toolRowIds: [], llmMod: makeLlmMod(), embedFn: fakeEmbed });
  assert.equal(r.status, 'success');
  assert.equal(r.retryable, false);
});

// 按 UTF-8 字节计量截断: 中文场景字符数远小于字节数, 不能复用按字符计量的 _truncate。
test('_truncateToBytes truncates by UTF-8 bytes head/tail', () => {
  const out = _truncateToBytes('中文中文中文', 10);   // 6 字符 = 18 字节 → 截到 10
  assert.ok(Buffer.byteLength(out) <= 10 + 40, '不超过上限+省略符');
  assert.ok(out.includes('condensed'), '含截断标记');
  assert.equal(_truncateToBytes('abc', 10), 'abc', '不超限原样返回');
  assert.equal(_truncateToBytes('abc', 0), 'abc', '0 = 不截断');
  assert.equal(_truncateToBytes('', 100), '', '空串返回空');
});

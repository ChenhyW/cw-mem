const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../lib/db');
const { Consumer } = require('../lib/queue');

function freshDb(dim = 4) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-q-'));
  return { dir, ...openDb(dir, dim) };
}

const SLEEP = ms => new Promise(r => setTimeout(r, ms));

// 最小 llm/embed 注入: summarize 按 kind 返回 canned JSON
function makeCtx(db) {
  const llmMod = {
    summarize: async ({ kind }) => {
      if (kind === 'tool_batch') return JSON.stringify({ title: '批量改', type: 'change', concepts: ['x'], filesChanged: ['a.js'], result: 'ok', sideEffect: '' });
      if (kind === 'result') return JSON.stringify({ request: 'r', investigated: '', learned: '', completed: 'c', next_steps: '', notes: '' });
      if (kind === 'session') return JSON.stringify({ request: 'r', investigated: '', learned: '', completed: 'c', next_steps: '', notes: '' });
      throw new Error('unknown kind ' + kind);
    },
    validateObservation: require('../lib/llm').validateObservation,
    setSummaryStatus: require('../lib/llm').setSummaryStatus,
    maxSummaryAttempts: require('../lib/llm').maxSummaryAttempts
  };
  const embedFn = async () => [[0.1, 0.2, 0.3, 0.4]];
  const cfg = () => ({
    llm: { enabled: true, apiKey: 'sk', model: 'm', apiBase: 'http://x', timeoutSeconds: 5, maxRetries: 3, retryIntervalSeconds: 0.01, summaryFieldLimit: 2000 },
    ollama: { url: 'http://x', embedModel: 'm', embedDim: 4 },
    toolSummary: { enabled: true, skipMode: 'on', payloadMaxBytes: 524288 },
    queue: { pollMs: 20, quiescenceSeconds: 0.02, toolGroupMax: 6, sweepIntervalSeconds: 60, spool: { enabled: false } }
  });
  return { llmMod, embedFn, cfg };
}

// 造一条 TOOL 行 + 其 tool_details
function seedTool(db, { id, sid = 's1', cpId = 'cp1', proj = '/p', tool = 'Write', fp, at = '2026-09-03T00:00:00Z' }) {
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, tool_name, tool_target, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, sid, cpId, proj, 'TOOL', tool, tool + ' ' + fp, at);
  db.prepare("INSERT INTO tool_details(prompt_id, tool_name, input_json, output_json, created_at) VALUES (?,?,?,?,?)")
    .run(id, tool, JSON.stringify({ path: fp }), '{}', at);
}

test('same-file tools accumulate, different file flushes the previous group', async () => {
  const { db, dir } = freshDb();
  const { llmMod, embedFn, cfg } = makeCtx(db);
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  seedTool(db, { id: 2, fp: '/a.js' });
  seedTool(db, { id: 3, fp: '/a.js' });
  seedTool(db, { id: 4, fp: '/b.js' });

  const c = new Consumer({ db, loadCfg: cfg, embedFn, llmMod });
  c.start();
  c.push({ kind: 'tool', sessionId: 's1', toolRowId: 2, toolTarget: 'Write /a.js' });
  c.push({ kind: 'tool', sessionId: 's1', toolRowId: 3, toolTarget: 'Write /a.js' });
  c.push({ kind: 'tool', sessionId: 's1', toolRowId: 4, toolTarget: 'Write /b.js' });
  await SLEEP(200);
  c.stop();

  // /a.js 组(id 2,3): 首行落 meta, 第二行 success 无 meta; /b.js 组: 4 单独成组落 meta
  const r2 = db.prepare("SELECT summary_meta, summary_status FROM prompts WHERE id=2").get();
  const r3 = db.prepare("SELECT summary_meta, summary_status FROM prompts WHERE id=3").get();
  const r4 = db.prepare("SELECT summary_meta, summary_status FROM prompts WHERE id=4").get();
  assert.ok(r2.summary_meta, '组1首行应落 meta');
  assert.equal(r3.summary_status, 'success');
  assert.ok(!r3.summary_meta, '组1非首行不应落 meta');
  assert.ok(r4.summary_meta, '组2首行应落 meta');
  // 只写 2 条 tool 向量(每组一条)
  assert.equal(db.prepare("SELECT COUNT(*) c FROM memories_meta WHERE entity_type='tool'").get().c, 2);
  fs.rmSync(dir, { recursive: true });
});

test('non-tool item flushes the open group first', async () => {
  const { db, dir } = freshDb();
  const { llmMod, embedFn, cfg } = makeCtx(db);
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, prompt, response, created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(1, 's1', 'cp1', '/p', 'PROMPT', '做某事', 'resp', '2026-09-03T00:00:00Z');
  seedTool(db, { id: 2, fp: '/a.js' });

  const c = new Consumer({ db, loadCfg: cfg, embedFn, llmMod });
  c.start();
  c.push({ kind: 'tool', sessionId: 's1', toolRowId: 2, toolTarget: 'Write /a.js' });
  c.push({ kind: 'result', sessionId: 's1', promptRowId: 1 });
  await SLEEP(200);
  c.stop();

  assert.ok(db.prepare("SELECT summary_meta FROM prompts WHERE id=2").get().summary_meta, 'tool 组应在 result 之前 flush');
  assert.equal(db.prepare("SELECT summary_status FROM prompts WHERE id=1").get().summary_status, 'success', 'result 摘要应完成');
  fs.rmSync(dir, { recursive: true });
});

test('summarizeGroup LLM failure does not throw and lands retryable state', async () => {
  const { db, dir } = freshDb();
  const ctx = makeCtx(db);
  ctx.llmMod.summarize = async () => { throw new Error('ollama down'); };
  const { llmMod, embedFn, cfg } = ctx;
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  seedTool(db, { id: 2, fp: '/a.js' });

  const c = new Consumer({ db, loadCfg: cfg, embedFn, llmMod });
  c.start();
  c.push({ kind: 'tool', sessionId: 's1', toolRowId: 2, toolTarget: 'Write /a.js' });
  c.push({ kind: 'flush', sessionId: 's1' });
  await SLEEP(200);
  c.stop();

  const r = db.prepare("SELECT summary_status, retry_attempts, summary_meta FROM prompts WHERE id=2").get();
  assert.equal(r.summary_status, 'failed_pending_retry', 'LLM 失败应落可重试状态');
  assert.ok(!r.summary_meta, '失败不应落 meta');
  fs.rmSync(dir, { recursive: true });
});

// quiescenceSeconds 拉到 5s: 隔离断言的窗口只有 50ms, 0.02s 的兜底定时器会在窗口内
// 自行 flush s2 的组, 使 openGroupCount() 恒为 0 —— 测的是"定时器还没跑完"而非隔离性。
// 拉长后 s1 的显式 flush 成为唯一触发源, 断言才真正验证"flush s1 不影响 s2"。
const NO_QUIESCENCE_CFG = () => ({
  llm: { enabled: true, apiKey: 'sk', model: 'm', apiBase: 'http://x', timeoutSeconds: 5, maxRetries: 3, retryIntervalSeconds: 0.01, summaryFieldLimit: 2000 },
  ollama: { url: 'http://x', embedModel: 'm', embedDim: 4 },
  toolSummary: { enabled: true, skipMode: 'on', payloadMaxBytes: 524288 },
  queue: { pollMs: 20, quiescenceSeconds: 5, toolGroupMax: 6, sweepIntervalSeconds: 60, spool: { enabled: false } }
});

test('cross-session isolation: one session flushing does not disturb another', async () => {
  const { db, dir } = freshDb();
  const { llmMod, embedFn } = makeCtx(db);
  const cfg = NO_QUIESCENCE_CFG;
  for (const [sid, id] of [['s1', 2], ['s2', 3]]) {
    db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run(sid, '/p');
    seedTool(db, { id, sid, fp: '/' + sid + '.js' });
  }

  const c = new Consumer({ db, loadCfg: cfg, embedFn, llmMod });
  c.start();
  c.push({ kind: 'tool', sessionId: 's1', toolRowId: 2, toolTarget: 'Write /s1.js' });
  c.push({ kind: 'tool', sessionId: 's2', toolRowId: 3, toolTarget: 'Write /s2.js' });
  c.push({ kind: 'flush', sessionId: 's1' });   // 只 flush s1; s2 的组仍打开
  await SLEEP(50);
  const openAfter = c.openGroupCount();
  // 兜底已被拉长, 显式给 s2 一个 flush 来收尾
  c.push({ kind: 'flush', sessionId: 's2' });
  await SLEEP(200);
  c.stop();

  assert.ok(db.prepare("SELECT summary_meta FROM prompts WHERE id=2").get().summary_meta, 's1 应已 flush');
  assert.equal(openAfter, 1, 'flush s1 时 s2 的组应仍然打开');
  assert.equal(c.openGroupCount(), 0, 's2 显式 flush 后应无打开的组');
  assert.ok(db.prepare("SELECT summary_meta FROM prompts WHERE id=3").get().summary_meta, 's2 组最终也应摘要完成');
  fs.rmSync(dir, { recursive: true });
});

// 静默兜底: 无新 item 到达 quiescenceSeconds 后强制 flush 打开的组。
// 单消费者下这是唯一能解开"turn 在同一文件上结束且 Stop 未触发"的死锁。
test('quiescence timer flushes an open group with no further items', async () => {
  const { db, dir } = freshDb();
  const { llmMod, embedFn, cfg } = makeCtx(db);
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  seedTool(db, { id: 2, fp: '/a.js' });

  const c = new Consumer({ db, loadCfg: cfg, embedFn, llmMod });
  c.start();
  c.push({ kind: 'tool', sessionId: 's1', toolRowId: 2, toolTarget: 'Write /a.js' });
  await SLEEP(80);                                  // quiescence=20ms, 远早于 pollMs 无影响
  c.stop();

  assert.ok(db.prepare("SELECT summary_meta FROM prompts WHERE id=2").get().summary_meta,
    '无后续 item 时组应由静默兜底 flush');
  assert.equal(c.openGroupCount(), 0, '兜底 flush 后应无打开的组');
  fs.rmSync(dir, { recursive: true });
});

test('group size cap splits into multiple groups', async () => {
  const { db, dir } = freshDb();
  const { llmMod, embedFn } = makeCtx(db);
  const cfg = () => ({
    llm: { enabled: true, apiKey: 'sk', model: 'm', apiBase: 'http://x', timeoutSeconds: 5, maxRetries: 3, retryIntervalSeconds: 0.01, summaryFieldLimit: 2000 },
    ollama: { url: 'http://x', embedModel: 'm', embedDim: 4 },
    toolSummary: { enabled: true, skipMode: 'on', payloadMaxBytes: 524288 },
    queue: { pollMs: 20, quiescenceSeconds: 0.02, toolGroupMax: 2, sweepIntervalSeconds: 60, spool: { enabled: false } }
  });
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  // 4 个同文件 Write, 组上限 2 → 应拆成 2 组
  for (const id of [2, 3, 4, 5]) seedTool(db, { id, fp: '/a.js' });

  const c = new Consumer({ db, loadCfg: cfg, embedFn, llmMod });
  c.start();
  for (const id of [2, 3, 4, 5]) c.push({ kind: 'tool', sessionId: 's1', toolRowId: id, toolTarget: 'Write /a.js' });
  await SLEEP(250);
  c.stop();

  const metas = [2, 3, 4, 5].map(id => !!db.prepare("SELECT summary_meta FROM prompts WHERE id=?").get(id).summary_meta);
  assert.deepEqual(metas, [true, false, true, false], '两个满组各落首行 meta');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM memories_meta WHERE entity_type='tool'").get().c, 2);
  fs.rmSync(dir, { recursive: true });
});

test('queueDepth and openGroupCount reflect live state', async () => {
  const { db, dir } = freshDb();
  const { llmMod, embedFn } = makeCtx(db);
  const cfg = NO_QUIESCENCE_CFG;   // 兜底须在 80ms 窗口外, 否则组已被自动 flush, openGroupCount 恒为 0
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  seedTool(db, { id: 2, fp: '/a.js' });

  const c = new Consumer({ db, loadCfg: cfg, embedFn, llmMod });
  assert.equal(c.queueDepth(), 0);
  assert.equal(c.openGroupCount(), 0);
  c.start();
  c.push({ kind: 'tool', sessionId: 's1', toolRowId: 2, toolTarget: 'Write /a.js' });
  await SLEEP(80);
  assert.equal(c.openGroupCount(), 1, '打开的组应可见');
  c.stop();
  fs.rmSync(dir, { recursive: true });
});

// ── Task 6: 恢复 / spool / 向量补齐 ──────────────────────────────────────────

test('recover rebuilds toolgroup / result / session items from DB state', async () => {
  const { db, dir } = freshDb();
  const { llmMod, embedFn, cfg } = makeCtx(db);
  db.prepare("INSERT INTO sessions(id, project_dir, ended_at) VALUES(?,?,?)")
    .run('s1', '/p', '2026-09-03T00:00:00Z');
  // TOOL 行: summary_status 为默认空串 = 从未处理
  seedTool(db, { id: 2, fp: '/a.js' });
  seedTool(db, { id: 3, fp: '/a.js' });     // 同 target → 应并入同一 toolgroup
  seedTool(db, { id: 4, fp: '/b.js' });     // 不同 target → 另一组
  // PROMPT 行 1: 摘要已完成 → 不作为 result 待办, 但它的存在让 session 摘要成为必要
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, prompt, response, summary_meta, summary_status, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(1, 's1', 'cp1', '/p', 'PROMPT', 'r', 'resp', '{"request":"r","completed":"c"}', 'success', '2026-09-03T00:00:00Z');
  // PROMPT 行 5: 有回复、无摘要, summary_status 为默认空串
  // = server 写入 response 后、到达 /api/prompts/summarize 前崩溃, 最常见的崩溃场景
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, prompt, response, created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(5, 's1', 'cp2', '/p', 'PROMPT', 'r2', 'resp2', '2026-09-03T00:00:01Z');

  const c = new Consumer({ db, loadCfg: cfg, embedFn, llmMod });
  const pushed = [];
  c.push = it => pushed.push(it);
  c.recover();

  const kinds = pushed.map(p => p.kind).sort();
  assert.ok(kinds.includes('toolgroup'), '应重建 toolgroup');
  assert.ok(kinds.includes('result'), '应重建 result');
  assert.ok(pushed.filter(p => p.kind === 'result').some(p => p.promptRowId === 5),
    '无摘要的 PROMPT 行应被重建');
  assert.ok(!pushed.some(p => p.kind === 'result' && p.promptRowId === 1),
    '已完成的 PROMPT 行不应被重复重建');
  assert.ok(kinds.includes('session'), '应重建 session');

  // 复合键分桶: /a.js 的两行必须在同一组
  const groups = pushed.filter(p => p.kind === 'toolgroup');
  assert.equal(groups.length, 2, '两个不同 target 应各成一组');
  assert.deepEqual(groups.map(g => g.toolRowIds).map(ids => ids.slice().sort()),
    [[2, 3], [4]], '同 target 行应分入同一组');
  fs.rmSync(dir, { recursive: true });
});

test('recover skips completed rows but picks up failed_pending_retry ones', async () => {
  const { db, dir } = freshDb();
  const { llmMod, embedFn, cfg } = makeCtx(db);
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, tool_name, tool_target, summary_status, retry_attempts, summary_meta, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(2, 's1', 'cp1', '/p', 'TOOL', 'Write', 'Write /done.js', 'success', 0, '{"title":"t","type":"change"}', '2026-09-03T00:00:00Z');
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, tool_name, tool_target, summary_status, retry_attempts, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(3, 's1', 'cp1', '/p', 'TOOL', 'Write', 'Write /retry.js', 'failed_pending_retry', 1, '2026-09-03T00:00:00Z');
  // 已 failed_final = 超过重试上限, 不应重建
  db.prepare("INSERT INTO prompts(id, session_id, project_dir, type, tool_name, tool_target, summary_status, retry_attempts, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(4, 's1', '/p', 'TOOL', 'Write', 'Write /final.js', 'failed_final', 3, '2026-09-03T00:00:00Z');

  const c = new Consumer({ db, loadCfg: cfg, embedFn, llmMod });
  const pushed = [];
  c.push = it => pushed.push(it);
  c.recover();

  const ids = pushed.filter(p => p.kind === 'toolgroup').flatMap(p => p.toolRowIds);
  assert.deepEqual(ids, [3], '只应重建 failed_pending_retry 行');
  fs.rmSync(dir, { recursive: true });
});

test('recover splits oversized buckets at toolGroupMax', async () => {
  const { db, dir } = freshDb();
  const { llmMod, embedFn } = makeCtx(db);
  const cfg = () => ({
    llm: { enabled: true, apiKey: 'sk', model: 'm', apiBase: 'http://x', timeoutSeconds: 5, maxRetries: 3, retryIntervalSeconds: 0.01, summaryFieldLimit: 2000 },
    ollama: { url: 'http://x', embedModel: 'm', embedDim: 4 },
    toolSummary: { enabled: true, skipMode: 'on', payloadMaxBytes: 524288 },
    queue: { pollMs: 20, quiescenceSeconds: 0.02, toolGroupMax: 2, sweepIntervalSeconds: 60, spool: { enabled: false } }
  });
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  for (const id of [2, 3, 4, 5, 6]) seedTool(db, { id, fp: '/a.js' });

  const c = new Consumer({ db, loadCfg: cfg, embedFn, llmMod });
  const pushed = [];
  c.push = it => pushed.push(it);
  c.recover();

  const groups = pushed.filter(p => p.kind === 'toolgroup').map(p => p.toolRowIds);
  assert.deepEqual(groups, [[2, 3], [4, 5], [6]], '5 行按上限 2 拆成 3 组');
  fs.rmSync(dir, { recursive: true });
});

test('drainSpool applies spooled items, deletes the file, and skips bad lines', async () => {
  const { db, dir } = freshDb();
  const { llmMod, embedFn, cfg } = makeCtx(db);
  fs.mkdirSync(path.join(dir, 'spool'));
  fs.writeFileSync(path.join(dir, 'spool', '1700000000000-1.jsonl'),
    JSON.stringify({ path: '/api/sessions', body: { sessionId: 'sX', projectDir: '/p' } }) + '\n'
    + 'not json at all\n'                                                    // 坏行应被跳过
    + JSON.stringify({ path: '/api/sessions', body: { sessionId: 'sY', projectDir: '/p' } }) + '\n');

  const c = new Consumer({ db, loadCfg: cfg, embedFn, llmMod });
  const handlers = {
    '/api/sessions': body => db.prepare(
      'INSERT OR IGNORE INTO sessions(id, project_dir, started_at, last_seen_at) VALUES(?,?,?,?)'
    ).run(body.sessionId, body.projectDir, 't', 't')
  };
  c.drainSpool(dir, handlers);

  assert.ok(db.prepare("SELECT id FROM sessions WHERE id='sX'").get(), '第 1 条已写入');
  assert.ok(db.prepare("SELECT id FROM sessions WHERE id='sY'").get(), '坏行之后的记录仍应处理');
  assert.ok(!fs.existsSync(path.join(dir, 'spool', '1700000000000-1.jsonl')), '成功读取后文件应删除');
  fs.rmSync(dir, { recursive: true });
});

test('drainSpool is a no-op when the spool directory does not exist', async () => {
  const { db, dir } = freshDb();
  const { llmMod, embedFn, cfg } = makeCtx(db);
  const c = new Consumer({ db, loadCfg: cfg, embedFn, llmMod });
  assert.doesNotThrow(() => c.drainSpool(dir, {}), 'spool 目录缺失不应抛错');
  fs.rmSync(dir, { recursive: true });
});

test('vectorSweep re-vectorizes a row whose summary succeeded but vectorization failed', async () => {
  const { db, dir } = freshDb();
  const { llmMod, embedFn, cfg } = makeCtx(db);
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  const meta = JSON.stringify({ request: 'r', completed: 'c' });
  // summary_updated_at 必须早于 runVectorRetry 的 60s cutoff, 否则被跳过
  db.prepare("INSERT INTO prompts(id, session_id, project_dir, type, summary_meta, summary_status, vector_status, summary_updated_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(1, 's1', '/p', 'PROMPT', meta, 'success', 'failed', '2026-01-01T00:00:00Z', '2026-09-03T00:00:00Z');

  const c = new Consumer({ db, loadCfg: cfg, embedFn, llmMod });
  c.vectorSweep();
  await SLEEP(150);

  assert.equal(db.prepare("SELECT vector_status FROM prompts WHERE id=1").get().vector_status, 'success',
    '向量补齐应把 failed 行收敛为 success');
  assert.ok(db.prepare("SELECT COUNT(*) c FROM memories_meta WHERE entity_type='result'").get().c >= 1,
    '应写入向量行');
  fs.rmSync(dir, { recursive: true });
});

test('startFull drains spool, recovers, starts consuming, and stop() releases the sweep timer', async () => {
  const { db, dir } = freshDb();
  const { llmMod, embedFn, cfg } = makeCtx(db);
  fs.mkdirSync(path.join(dir, 'spool'));
  fs.writeFileSync(path.join(dir, 'spool', '1.jsonl'),
    JSON.stringify({ path: '/api/sessions', body: { sessionId: 'sZ', projectDir: '/p' } }) + '\n');
  // 一条待摘要的 TOOL 行, 供 recover 重建
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  seedTool(db, { id: 2, fp: '/a.js' });

  const c = new Consumer({ db, loadCfg: cfg, embedFn, llmMod });
  c.startFull({ '/api/sessions': b => db.prepare(
    'INSERT OR IGNORE INTO sessions(id, project_dir, started_at, last_seen_at) VALUES(?,?,?,?)'
  ).run(b.sessionId, b.projectDir, 't', 't') }, dir);

  await SLEEP(200);
  assert.ok(db.prepare("SELECT id FROM sessions WHERE id='sZ'").get(), 'spool 应被排空');
  assert.ok(db.prepare("SELECT summary_meta FROM prompts WHERE id=2").get().summary_meta,
    'recover 重建的待办应被消费');
  c.stop();
  fs.rmSync(dir, { recursive: true });
});

// ── Task 10: 端到端 ──────────────────────────────────────────────────────────
// 完整链路: tool 入队 → 流式聚合 flush → result 摘要(读到已落库的 tool 观察)
//        → session 摘要(读到已落库的 result 摘要) → 向量化。Lane FIFO 保证顺序。
test('end-to-end: tool items → flush → result → session', async () => {
  const { db, dir } = freshDb();
  const { llmMod, embedFn, cfg } = makeCtx(db);
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, prompt, response, created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(1, 's1', 'cp1', '/p', 'PROMPT', '做某事', 'final resp', '2026-09-03T00:00:00Z');
  seedTool(db, { id: 2, fp: '/a.js' });
  seedTool(db, { id: 3, fp: '/a.js' });     // 同文件, 与 2 同组
  seedTool(db, { id: 4, fp: '/b.js' });     // 不同文件, 触发前一组 flush

  const c = new Consumer({ db, loadCfg: cfg, embedFn, llmMod });
  c.start();
  c.push({ kind: 'tool', sessionId: 's1', toolRowId: 2, toolTarget: 'Write /a.js' });
  c.push({ kind: 'tool', sessionId: 's1', toolRowId: 3, toolTarget: 'Write /a.js' });
  c.push({ kind: 'tool', sessionId: 's1', toolRowId: 4, toolTarget: 'Write /b.js' });
  // result 必在 tool 组 flush 之后处理 —— handle 开头 await #flush 保证
  c.push({ kind: 'result', sessionId: 's1', promptRowId: 1 });
  db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run('2026-09-03T00:00:10Z', 's1');
  c.push({ kind: 'session', sessionId: 's1' });
  await SLEEP(300);
  c.stop();

  // tool 组: /a.js 首行(2)落 meta, 3 success 无 meta; /b.js(4)落 meta
  assert.ok(db.prepare("SELECT summary_meta FROM prompts WHERE id=2").get().summary_meta, '/a.js 组首行应落 meta');
  assert.ok(!db.prepare("SELECT summary_meta FROM prompts WHERE id=3").get().summary_meta, '/a.js 组非首行不应落 meta');
  assert.equal(db.prepare("SELECT summary_status FROM prompts WHERE id=3").get().summary_status, 'success');
  assert.ok(db.prepare("SELECT summary_meta FROM prompts WHERE id=4").get().summary_meta, '/b.js 组应落 meta');

  // result 摘要完成且引用了 tool 观察
  const p = db.prepare("SELECT summary_status, summary_meta FROM prompts WHERE id=1").get();
  assert.equal(p.summary_status, 'success', 'result 摘要应完成');
  assert.ok(p.summary_meta, 'result 摘要应落 meta');

  // session 摘要完成
  const ss = db.prepare("SELECT COUNT(*) c FROM session_summaries WHERE session_id='s1'").get();
  assert.equal(ss.c, 1, '应有一条 session 摘要');

  // 向量: 两组 tool 各一条 + result 一条 = 3
  const vc = db.prepare("SELECT COUNT(*) c FROM memories_meta WHERE entity_type IN ('tool','result')").get().c;
  assert.equal(vc, 3, '应写入 3 条向量(2 tool 组 + 1 result)');

  fs.rmSync(dir, { recursive: true });
});

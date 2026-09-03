const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../lib/db');
const { runStopBatch, runSessionSummary } = require('../lib/batch');

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
  llm: { enabled: true, apiKey: 'sk-x', model: 'm', apiBase: 'http://x', timeoutSeconds: 5, maxRetries: 0 },
  ollama: { url: 'http://x', embedModel: 'm', embedDim: 4 },
  toolSummary: { enabled: true, skipMode: 'on' },
  recall: { topK: 5, minScore: 0.0, injectMaxCount: 8, injectMaxTokens: 800 }
};

test('runStopBatch writes tool obs + result summary + 3 memories', async () => {
  const { db } = freshDb();
  // seed: session + 1 PROMPT + 2 TOOL rows + tool_details
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, prompt, response, created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(1, 's1', 'cp1', '/p', 'PROMPT', '做某事', 'final response text', '2026-09-03T00:00:00Z');
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, tool_name, prompt, created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(2, 's1', 'cp1', '/p', 'TOOL', 'Bash', 'Bash: ls', '2026-09-03T00:00:01Z');
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, tool_name, prompt, created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(3, 's1', 'cp1', '/p', 'TOOL', 'Write', 'Write: a.js', '2026-09-03T00:00:02Z');
  db.prepare("INSERT INTO tool_details(prompt_id, tool_use_id, tool_name, input_json, output_json, created_at) VALUES(?,?,?,?,?,?)")
    .run(2, 'tu1', 'Bash', '{"command":"ls"}', '{"stdout":"a\\nb"}', '2026-09-03T00:00:01Z');
  db.prepare("INSERT INTO tool_details(prompt_id, tool_use_id, tool_name, input_json, output_json, created_at) VALUES(?,?,?,?,?,?)")
    .run(3, 'tu2', 'Write', '{"path":"a.js"}', '{"ok":true}', '2026-09-03T00:00:02Z');

  const llmMod = makeLlmMod();
  await runStopBatch({ db, cfg: baseCfg, promptRowId: 1, llmMod, embedFn: fakeEmbed });

  // TOOL rows got summary_meta
  const t2 = db.prepare("SELECT summary_meta, summary_status FROM prompts WHERE id=2").get();
  const t3 = db.prepare("SELECT summary_meta, summary_status FROM prompts WHERE id=3").get();
  assert.ok(t2.summary_meta, 'tool row 2 missing summary_meta');
  assert.ok(t3.summary_meta, 'tool row 3 missing summary_meta');
  assert.equal(t2.summary_status, 'success');
  assert.equal(t3.summary_status, 'success');

  // PROMPT row got result summary
  const p1 = db.prepare("SELECT summary, summary_status FROM prompts WHERE id=1").get();
  assert.ok(p1.summary, 'prompt row missing summary');
  assert.equal(p1.summary_status, 'success');

  // memories_meta has 3 rows (2 tool + 1 result), all not skip
  const memCount = db.prepare("SELECT COUNT(*) c FROM memories_meta").get().c;
  assert.equal(memCount, 3);
  const skipCount = db.prepare("SELECT COUNT(*) c FROM memories_meta WHERE type='skip'").get().c;
  assert.equal(skipCount, 0);
});

test('runStopBatch skips tool obs when toolSummary disabled', async () => {
  const { db } = freshDb();
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, prompt, response, created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(1, 's1', 'cp1', '/p', 'PROMPT', '做某事', 'resp', '2026-09-03T00:00:00Z');
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, tool_name, prompt, created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(2, 's1', 'cp1', '/p', 'TOOL', 'Bash', 'Bash: ls', '2026-09-03T00:00:00Z');

  const cfg = { ...baseCfg, toolSummary: { enabled: false, skipMode: 'on' } };
  const llmMod = makeLlmMod();
  await runStopBatch({ db, cfg, promptRowId: 1, llmMod, embedFn: fakeEmbed });

  // tool row should NOT have summary_meta
  const t2 = db.prepare("SELECT summary_meta FROM prompts WHERE id=2").get();
  assert.ok(!t2.summary_meta);
  // result summary still written; memories_meta has 1 (result only)
  const memCount = db.prepare("SELECT COUNT(*) c FROM memories_meta").get().c;
  assert.equal(memCount, 1);
});

test('runStopBatch keeps success status when vectorization fails', async () => {
  const { db } = freshDb();
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, prompt, response, created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(1, 's1', 'cp1', '/p', 'PROMPT', '做某事', 'resp', '2026-09-03T00:00:00Z');
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, tool_name, prompt, created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(2, 's1', 'cp1', '/p', 'TOOL', 'Bash', 'Bash: ls', '2026-09-03T00:00:01Z');
  db.prepare("INSERT INTO tool_details(prompt_id, tool_use_id, tool_name, input_json, output_json, created_at) VALUES(?,?,?,?,?,?)")
    .run(2, 'tu1', 'Bash', '{"command":"ls"}', '{"stdout":"a"}', '2026-09-03T00:00:01Z');

  // 向量化全程抛错(模拟 ollama 超时/维度不匹配)
  const throwingEmbed = async () => { throw new Error('ollama timeout'); };
  const llmMod = makeLlmMod();
  await runStopBatch({ db, cfg: baseCfg, promptRowId: 1, llmMod, embedFn: throwingEmbed });

  const t2 = db.prepare("SELECT summary_status, summary_meta FROM prompts WHERE id=2").get();
  assert.equal(t2.summary_status, 'success', '工具摘要已成功, 向量化失败不应回退');
  assert.ok(t2.summary_meta, '工具摘要内容应已落库');
  const p1 = db.prepare("SELECT summary_status, summary FROM prompts WHERE id=1").get();
  assert.equal(p1.summary_status, 'success', 'PROMPT 摘要已成功, 向量化失败不应回退');
  assert.ok(p1.summary, 'PROMPT 摘要内容应已落库');
  // 向量化全失败 → memories_meta 无新增
  const memCount = db.prepare("SELECT COUNT(*) c FROM memories_meta").get().c;
  assert.equal(memCount, 0);
});

test('runStopBatch does not redo already-success tool observations', async () => {
  const { db } = freshDb();
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, prompt, response, created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(1, 's1', 'cp1', '/p', 'PROMPT', '做某事', 'resp', '2026-09-03T00:00:00Z');
  // TOOL 行已 success: 父 PROMPT 重试时不应被重做, 也不应回退成 failed
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, tool_name, prompt, summary_status, summary_meta, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(2, 's1', 'cp1', '/p', 'TOOL', 'Bash', 'Bash: ls', 'success', '{"title":"已成功","type":"change","concepts":[],"filesChanged":[],"result":"ok"}', '2026-09-03T00:00:01Z');
  db.prepare("INSERT INTO tool_details(prompt_id, tool_use_id, tool_name, input_json, output_json, created_at) VALUES(?,?,?,?,?,?)")
    .run(2, 'tu1', 'Bash', '{"command":"ls"}', '{"stdout":"a"}', '2026-09-03T00:00:01Z');

  let toolCalls = 0;
  const base = makeLlmMod();
  const llmMod = {
    ...base,
    summarize: async ({ kind }) => {
      if (kind === 'tool') { toolCalls++; throw new Error('success tool should not be re-summarized'); }
      return base.summarize({ kind });
    }
  };
  await runStopBatch({ db, cfg: baseCfg, promptRowId: 1, llmMod, embedFn: fakeEmbed });

  assert.equal(toolCalls, 0, '已成功的工具观察不应再调 LLM');
  const t2 = db.prepare("SELECT summary_status, summary_meta FROM prompts WHERE id=2").get();
  assert.equal(t2.summary_status, 'success', '已成功工具状态不应被回退');
  assert.equal(JSON.parse(t2.summary_meta).title, '已成功', '原摘要内容不应被覆盖');
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

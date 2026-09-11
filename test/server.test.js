const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_CONFIG } = require('../lib/config');

let serverHandle, port, dir;
async function boot() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-srv-'));
  const { startServer } = require('../lib/server');
  const handle = await startServer({ dataDir: dir, uiDir: path.join(__dirname,'..','ui'), port: 0 });
  serverHandle = handle.server; port = handle.port;
}
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname:'127.0.0.1', port, path:p, method, headers:{'Content-Type':'application/json'} }, res => {
      let b=''; res.on('data',c=>b+=c); res.on('end',()=>resolve({status:res.statusCode,body:b}));
    });
    r.on('error',reject); if(body) r.write(JSON.stringify(body)); r.end();
  });
}

test('GET /api/health returns ok', async () => { await boot(); try {
  assert.equal(JSON.parse((await req('GET','/api/health')).body).status, 'ok');
} finally { serverHandle.close(); fs.rmSync(dir,{recursive:true}); } });

test('POST /api/sessions + /api/prompts creates a row', async () => { await boot(); try {
  await req('POST','/api/sessions', { sessionId:'s1', projectDir:'/p' });
  const j = JSON.parse((await req('POST','/api/prompts', { sessionId:'s1', prompt:'hi', type:'PROMPT', claudePromptId:'cp1', projectDir:'/p' })).body);
  assert.equal(j.status,'ok'); assert.ok(j.id > 0);
} finally { serverHandle.close(); fs.rmSync(dir,{recursive:true}); } });

const SLEEP = ms => new Promise(r => setTimeout(r, ms));

test('TOOL prompt row gets a tool_target and tool-details enqueues a group', async () => { await boot(); try {
  await req('POST','/api/sessions', { sessionId:'s1', projectDir:'/p' });
  const pj = JSON.parse((await req('POST','/api/prompts', {
    sessionId:'s1', prompt:'Write: a.js', type:'TOOL', toolName:'Write',
    claudePromptId:'cp1', projectDir:'/p', filePath:'/a.js'
  })).body);
  assert.ok(pj.id > 0);
  const tj = JSON.parse((await req('POST','/api/tool-details', {
    promptId: pj.id, sessionId:'s1', filePath:'/a.js',
    toolInput:{ path:'/a.js' }, toolOutput:{ ok:true }, toolName:'Write'
  })).body);
  assert.equal(tj.status,'ok');

  await SLEEP(150);
  const q = JSON.parse((await req('GET','/api/queue')).body);
  assert.equal(q.openGroups, 1, 'tool item 应已开一个聚合组(默认 30s 静默兜底不会在此关闭)');
} finally { serverHandle.close(); fs.rmSync(dir,{recursive:true}); } });

test('POST /api/prompts/summarize returns queued and the consumer picks it up', async () => { await boot(); try {
  await req('POST','/api/sessions', { sessionId:'s1', projectDir:'/p' });
  const pj = JSON.parse((await req('POST','/api/prompts', {
    sessionId:'s1', prompt:'hi', type:'PROMPT', claudePromptId:'cp1', projectDir:'/p'
  })).body);
  assert.equal(pj.status,'ok');
  await req('POST','/api/prompts/response', { promptId:'cp1', sessionId:'s1', response:'resp' });
  const j = JSON.parse((await req('POST','/api/prompts/summarize', { sessionId:'s1', promptId:'cp1' })).body);
  assert.equal(j.status,'ok');
  assert.equal(j.queued, true);
  assert.equal(j.id, pj.id);

  await SLEEP(200);
  // 证明 item 真的被消费了(不只是入队): LLM 未配置时走行级状态机落 failed_final,
  // 而不是永远停在 pending。
  const rows = JSON.parse((await req('GET','/api/prompts?sessionId=s1')).body);
  const row = rows.prompts.find(p => p.id === pj.id);
  assert.notEqual(row.summary_status, '', '队列应已消费该 item 并落状态');
  assert.ok(!['pending', 'generating'].includes(row.summary_status),
    '不应卡在 pending/generating, 实际 ' + row.summary_status);
} finally { serverHandle.close(); fs.rmSync(dir,{recursive:true}); } });

test('POST /api/prompts/summarize skips when there is no response yet', async () => { await boot(); try {
  await req('POST','/api/sessions', { sessionId:'s1', projectDir:'/p' });
  const pj = JSON.parse((await req('POST','/api/prompts', {
    sessionId:'s1', prompt:'hi', type:'PROMPT', claudePromptId:'cp1', projectDir:'/p'
  })).body);
  assert.ok(pj.id > 0);
  // 无 response → 跳过, 不入队
  const a = JSON.parse((await req('POST','/api/prompts/summarize', { sessionId:'s1', promptId:'cp1' })).body);
  assert.equal(a.status, 'skipped');
  // 缺 promptId → 跳过
  const b = JSON.parse((await req('POST','/api/prompts/summarize', { sessionId:'s1' })).body);
  assert.equal(b.status, 'skipped');
  // 不存在的行 → 跳过
  const c = JSON.parse((await req('POST','/api/prompts/summarize', { sessionId:'s1', promptId:'nope' })).body);
  assert.equal(c.status, 'skipped');
  await SLEEP(100);
  const q = JSON.parse((await req('GET','/api/queue')).body);
  assert.equal(q.queued, 0, '跳过的请求不应入队');
} finally { serverHandle.close(); fs.rmSync(dir,{recursive:true}); } });

test('GET /api/queue reports queue depth and open groups', async () => { await boot(); try {
  const q = JSON.parse((await req('GET','/api/queue')).body);
  assert.equal(typeof q.queued,'number');
  assert.equal(typeof q.openGroups,'number');
  assert.equal(q.openGroups, 0);
} finally { serverHandle.close(); fs.rmSync(dir,{recursive:true}); } });

test('POST /api/config accepts queue section and payloadMaxBytes', async () => { await boot(); try {
  const r = JSON.parse((await req('POST','/api/config', {
    queue:{ pollMs:100, quiescenceSeconds:60, toolGroupMax:3, sweepIntervalSeconds:120, spool:{ enabled:true } },
    toolSummary:{ payloadMaxBytes: 1048576 },
    recall:{ minCosine: 0.72 }
  })).body);
  assert.equal(r.status,'ok');
  assert.equal(r.config.queue.pollMs, 100);
  assert.equal(r.config.queue.quiescenceSeconds, 60);
  assert.equal(r.config.queue.toolGroupMax, 3);
  assert.equal(r.config.queue.sweepIntervalSeconds, 120);
  assert.equal(r.config.queue.spool.enabled, true);
  assert.equal(r.config.toolSummary.payloadMaxBytes, 1048576);
  // 余弦阈值即时生效: 设置面板存的就是这个键, 改名后若这里不认, 调参会静默失效
  assert.equal(r.config.recall.minCosine, 0.72);
  assert.equal(r.config.recall.minScore, undefined);
  // 落盘后可读回
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8'));
  assert.equal(onDisk.queue.toolGroupMax, 3);
  assert.equal(onDisk.toolSummary.payloadMaxBytes, 1048576);
  assert.equal(onDisk.recall.minCosine, 0.72);
} finally { serverHandle.close(); fs.rmSync(dir,{recursive:true}); } });

test('server drains a spool written while it was down', async () => {
  const { startServer } = require('../lib/server');
  const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-spool-'));
  // 模拟 hook 在 server 宕机期间写下的兜底记录
  fs.mkdirSync(path.join(spoolDir, 'spool'));
  fs.writeFileSync(path.join(spoolDir, 'spool', '1700000000000-1.jsonl'),
    JSON.stringify({ path: '/api/sessions', body: { sessionId: 'sS', projectDir: '/p' } }) + '\n' +
    JSON.stringify({ path: '/api/prompts', body: {
      sessionId: 'sS', prompt: 'Write: a.js', type: 'TOOL', toolName: 'Write',
      claudePromptId: 'cp1', projectDir: '/p', filePath: '/a.js'
    } }) + '\n');

  const handle = await startServer({ dataDir: spoolDir, uiDir: path.join(__dirname,'..','ui'), port: 0 });
  serverHandle = handle.server; port = handle.port;
  try {
    await SLEEP(200);
    const sess = JSON.parse((await req('GET','/api/sessions')).body);
    assert.ok(sess.sessions.some(s => s.id === 'sS'), 'spooled session 应已落库');

    const prompts = JSON.parse((await req('GET','/api/prompts?sessionId=sS')).body);
    assert.equal(prompts.total, 1, 'spooled TOOL 行应已落库');
    assert.equal(prompts.prompts[0].tool_target, 'Write /a.js',
      'tool_target 复合键应由排空时同一路径生成, 而非第二套写入逻辑');

    assert.ok(!fs.existsSync(path.join(spoolDir, 'spool', '1700000000000-1.jsonl')),
      '排空后 spool 文件应删除');
    assert.equal(JSON.parse((await req('GET','/api/queue')).body).openGroups, 0,
      'spool 排空不应产生未关闭的聚合组');
  } finally {
    serverHandle.close();
    fs.rmSync(spoolDir, { recursive: true });
  }
});

// 完整模拟 hook 在 server 宕机期间写下的三条记录 —— tool-details 拿不到自增 promptId,
// 必须靠 tool_use_id 回退关联, 否则工具 I/O 会成为孤儿行(这正是最初的丢失路径)。
test('spool replay of a full tool call reconstructs row, details and group', async () => {
  const { startServer } = require('../lib/server');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-spool2-'));
  fs.mkdirSync(path.join(d, 'spool'));
  fs.writeFileSync(path.join(d, 'spool', '1.jsonl'),
    JSON.stringify({ path: '/api/sessions', body: { sessionId: 'sS', projectDir: '/p' } }) + '\n' +
    JSON.stringify({ path: '/api/prompts', body: {
      sessionId: 'sS', prompt: 'Write: a.js', type: 'TOOL', toolName: 'Write',
      toolUseId: 'tool_1', claudePromptId: 'cp1', projectDir: '/p', filePath: '/a.js'
    } }) + '\n' +
    JSON.stringify({ path: '/api/tool-details', body: {
      promptId: null, sessionId: 'sS', filePath: '/a.js',
      toolInput: { path: '/a.js', content: 'x' }, toolOutput: { stdout: 'ok' },
      toolUseId: 'tool_1', toolName: 'Write', durationMs: 12
    } }) + '\n');

  const handle = await startServer({ dataDir: d, uiDir: path.join(__dirname,'..','ui'), port: 0 });
  serverHandle = handle.server; port = handle.port;
  try {
    await SLEEP(150);
    const prompts = JSON.parse((await req('GET','/api/prompts?sessionId=sS')).body);
    assert.equal(prompts.total, 1);
    assert.equal(prompts.prompts[0].tool_use_id, 'tool_1', 'TOOL 行应落 tool_use_id 供回退关联');
    assert.equal(prompts.prompts[0].tool_target, 'Write /a.js');

    const td = JSON.parse((await req('GET','/api/tool-details?id=' + prompts.prompts[0].id)).body);
    assert.equal(td.input.path, '/a.js', 'tool_details 应挂到正确的 TOOL 行, 而非孤儿行');
    assert.equal(td.output.stdout, 'ok');

    const q = JSON.parse((await req('GET','/api/queue')).body);
    assert.equal(q.openGroups, 1, '排空进来的 tool item 应开一个聚合组');
  } finally {
    serverHandle.close();
    fs.rmSync(d, { recursive: true });
  }
});

test('tool I/O is truncated to toolSummary.payloadMaxBytes', async () => { await boot(); try {
  await req('POST','/api/config', { toolSummary:{ payloadMaxBytes: 50 } });
  await req('POST','/api/sessions', { sessionId:'s1', projectDir:'/p' });
  const pj = JSON.parse((await req('POST','/api/prompts', {
    sessionId:'s1', prompt:'Write: big', type:'TOOL', toolName:'Write',
    claudePromptId:'cp1', projectDir:'/p', filePath:'/big.js'
  })).body);
  const big = 'x'.repeat(5000);
  await req('POST','/api/tool-details', {
    promptId: pj.id, toolInput:{ path:'/big.js', content: big }, toolOutput:{ ok:true }, toolName:'Write'
  });
  const rows = JSON.parse((await req('GET','/api/tool-details?id=' + pj.id)).body);
  const stored = rows.rows ? rows.rows[0] : rows;
  assert.ok(Buffer.byteLength(JSON.stringify(stored.input)) <= 200,
    '落库 input 应被截断到上限附近, 实际 ' + Buffer.byteLength(JSON.stringify(stored.input)));
} finally { serverHandle.close(); fs.rmSync(dir,{recursive:true}); } });

// 回归: 运行中保存曾只判 typeof, 越界值被照单全收并落盘 —— 期间 injectMaxCount=-3 让
// `hits.length >= -3` 恒真, 注入永远 0 命中; 脏值要等下次重启才被 loadConfig 夹回默认值。
test('POST /api/config rejects out-of-range values and never persists them', async () => { await boot(); try {
  const bad = JSON.parse((await req('POST','/api/config', {
    recall:{ topK:9999, minCosine:-1, injectMaxCount:-3, injectMaxTokens:9 },
    queue:{ pollMs:5, toolGroupMax:0 },
    log:{ retentionDays:9999, maxPreviewChars:2, level:'verbose' },
    server:{ port:99999 }
  })).body);
  assert.equal(bad.status, 'ok', '忽略非法值不等于报错');
  // 全新数据目录无 config.json, 期望值就是默认值
  assert.equal(bad.config.recall.topK, DEFAULT_CONFIG.recall.topK);
  assert.equal(bad.config.recall.minCosine, DEFAULT_CONFIG.recall.minCosine);
  assert.equal(bad.config.recall.injectMaxCount, DEFAULT_CONFIG.recall.injectMaxCount, '负数条数不能写进去, 否则注入恒为 0 命中');
  assert.equal(bad.config.recall.injectMaxTokens, DEFAULT_CONFIG.recall.injectMaxTokens);
  assert.equal(bad.config.queue.pollMs, DEFAULT_CONFIG.queue.pollMs);
  assert.equal(bad.config.queue.toolGroupMax, DEFAULT_CONFIG.queue.toolGroupMax);
  assert.equal(bad.config.log.retentionDays, DEFAULT_CONFIG.log.retentionDays);
  assert.equal(bad.config.log.maxPreviewChars, DEFAULT_CONFIG.log.maxPreviewChars);
  assert.equal(bad.config.log.level, DEFAULT_CONFIG.log.level, '非法 log level 也要被忽略');
  assert.equal(bad.config.server.port, DEFAULT_CONFIG.server.port);
  // 关键: 磁盘上也不能留脏值, 否则重启前后行为不一致
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8'));
  assert.equal(onDisk.recall.topK, DEFAULT_CONFIG.recall.topK);
  assert.equal(onDisk.recall.minCosine, DEFAULT_CONFIG.recall.minCosine);
  assert.equal(onDisk.recall.injectMaxCount, DEFAULT_CONFIG.recall.injectMaxCount);
  assert.equal(onDisk.log.level, 'info');
  assert.equal(onDisk.server.port, 37889);

  // 合法值仍然生效
  const good = JSON.parse((await req('POST','/api/config', {
    recall:{ minCosine:0.72 }, queue:{ pollMs:300 }
  })).body);
  assert.equal(good.config.recall.minCosine, 0.72);
  assert.equal(good.config.queue.pollMs, 300);
  assert.equal(good.needRestart, false, '非需重启项变更不应报 needRestart');

  // needRestart 按实际差异判断: 改了端口要报, 存同一个值不该再报
  const moved = JSON.parse((await req('POST','/api/config', { server:{ port:39000 } })).body);
  assert.equal(moved.config.server.port, 39000);
  assert.equal(moved.needRestart, true);
  const same = JSON.parse((await req('POST','/api/config', { server:{ port:39000 } })).body);
  assert.equal(same.needRestart, false, '存同值不应误报需重启');
} finally { serverHandle.close(); fs.rmSync(dir,{recursive:true}); } });

// 回归: session_summaries 此前只有写入方(batch.js)和注入方(recall.js), 没有任何只读端点,
// 所以库里已有摘要在 UI 上始终看不见。
test('GET /api/session-summaries returns summaries with project filter and pagination', async () => { await boot(); try {
  await req('POST','/api/sessions', { sessionId:'s1', projectDir:'/p' });
  await req('POST','/api/sessions', { sessionId:'s2', projectDir:'/other' });
  // session_summaries 的写入方是 batch.js 的 LLM 任务, 这里直接落库模拟其产物
  const d = require('better-sqlite3')(path.join(dir, 'cw-mem.db'));
  const ins = d.prepare('INSERT INTO session_summaries(session_id, request, learned, completed, next_steps, created_at) VALUES(?,?,?,?,?,?)');
  ins.run('s1', '修 cw-mem 队列', '学到 X', '完成 Y', '下一步 Z', '2026-09-10T00:00:00.000Z');
  ins.run('s2', '无关会话', '学到 A', null, null, '2026-09-11T00:00:00.000Z');
  ins.run('s2', null, null, null, null, '2026-09-12T00:00:00.000Z');  // 全空, 应被过滤
  d.close();

  const all = JSON.parse((await req('GET','/api/session-summaries')).body);
  assert.equal(all.total, 2, '全空摘要应被过滤, 实际 ' + all.total);
  assert.equal(all.summaries.length, 2);
  assert.equal(all.summaries[0].session_id, 's2', '应按 created_at 倒序');
  assert.equal(all.summaries[0].project_dir, '/other', '应 JOIN sessions 补出 project_dir');
  assert.equal(all.summaries[1].learned, '学到 X');

  const p = JSON.parse((await req('GET','/api/session-summaries?project=/p')).body);
  assert.equal(p.total, 1, '项目过滤应只返回该项目');
  assert.equal(p.summaries[0].session_id, 's1');
  assert.equal(p.summaries[0].completed, '完成 Y');

  const q = JSON.parse((await req('GET','/api/session-summaries?limit=1&offset=1')).body);
  assert.equal(q.total, 2);
  assert.equal(q.summaries.length, 1);
  assert.equal(q.limit, 1);
} finally { serverHandle.close(); fs.rmSync(dir,{recursive:true}); } });

// 回归: 注入结果里除了 text/hits/error, 还要落阈值与候选数诊断字段,
// 否则"0 命中"和"阈值高于实际可达相似度"在 UI 上无法区分。
test('POST /api/recall/semantic records diagnostics on the PROMPT row', async () => { await boot(); try {
  await req('POST','/api/config', { llm:{ timeoutSeconds: 1 } });  // 缩短 embed 超时, 让测试快速失败
  await req('POST','/api/sessions', { sessionId:'s1', projectDir:'/p' });
  const pj = JSON.parse((await req('POST','/api/prompts', {
    sessionId:'s1', prompt:'hi', type:'PROMPT', claudePromptId:'cp1', projectDir:'/p'
  })).body);
  assert.ok(pj.id > 0);

  const r = JSON.parse((await req('POST','/api/recall/semantic', {
    sessionId:'s1', promptId:'cp1', project:'/p', prompt:'hi'
  })).body);
  assert.equal(typeof r.minCosine, 'number', '响应应带生效阈值(余弦)');
  assert.equal(typeof r.candidates, 'number', '响应应带 KNN 候选数');
  assert.ok('maxCosine' in r, '响应应带最高余弦');

  // 落库内容与响应一致 —— UI 只读落库内容
  const rows = JSON.parse((await req('GET','/api/prompts?sessionId=s1')).body);
  assert.ok(rows.prompts[0].injected_context, 'injected_context 应已写回 PROMPT 行');
  const stored = JSON.parse(rows.prompts[0].injected_context);
  assert.equal(stored.minCosine, r.minCosine);
  assert.equal(stored.candidates, r.candidates);
  assert.equal(stored.maxCosine, r.maxCosine);
} finally { serverHandle.close(); fs.rmSync(dir,{recursive:true}); } });

// 回归: claude 的 prompt_id 在同一 session 内会重复(实测 <task-notification> 与真实用户 prompt
// 共用同一个 id)。按 claude_prompt_id 匹配会把一次注入覆盖到多条历史行, 最早的记录被静默丢弃。
test('injection targets the exact row via rowId instead of a claude_prompt_id sibling', async () => { await boot(); try {
  await req('POST','/api/config', { llm:{ timeoutSeconds: 1 } });
  await req('POST','/api/sessions', { sessionId:'s1', projectDir:'/p' });
  const a = JSON.parse((await req('POST','/api/prompts', {
    sessionId:'s1', prompt:'真实 prompt', type:'PROMPT', claudePromptId:'dup1', projectDir:'/p'
  })).body);
  const b = JSON.parse((await req('POST','/api/prompts', {
    sessionId:'s1', prompt:'<task-notification>...', type:'PROMPT', claudePromptId:'dup1', projectDir:'/p'
  })).body);
  assert.notEqual(a.id, b.id, '两条同 claude_prompt_id 的行应各有一条记录');

  const r = JSON.parse((await req('POST','/api/recall/semantic', {
    sessionId:'s1', rowId: a.id, promptId:'dup1', project:'/p', prompt:'真实 prompt'
  })).body);
  const rows = JSON.parse((await req('GET','/api/prompts?sessionId=s1')).body);
  const rowA = rows.prompts.find(p => p.id === a.id);
  const rowB = rows.prompts.find(p => p.id === b.id);

  assert.ok(rowA.injected_context, 'rowId 指向的行应写入注入记录');
  assert.deepEqual(JSON.parse(rowA.injected_context), r, '落库内容应与响应一致');
  assert.equal(rowB.injected_context, null,
    '同 claude_prompt_id 的兄弟行不应被覆盖, 实际 ' + rowB.injected_context);

  // rowId 缺省时退回旧匹配逻辑, 保持向后兼容
  await req('POST','/api/prompts', { sessionId:'s1', prompt:'第三条', type:'PROMPT', claudePromptId:'dup2', projectDir:'/p' });
  await req('POST','/api/recall/semantic', { sessionId:'s1', promptId:'dup2', project:'/p', prompt:'第三条' });
  const rows2 = JSON.parse((await req('GET','/api/prompts?sessionId=s1')).body);
  assert.ok(rows2.prompts.find(p => p.claude_prompt_id === 'dup2').injected_context,
    '未传 rowId 时应仍能按 claude_prompt_id 写回');
} finally { serverHandle.close(); fs.rmSync(dir,{recursive:true}); } });

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
    toolSummary:{ payloadMaxBytes: 1048576 }
  })).body);
  assert.equal(r.status,'ok');
  assert.equal(r.config.queue.pollMs, 100);
  assert.equal(r.config.queue.quiescenceSeconds, 60);
  assert.equal(r.config.queue.toolGroupMax, 3);
  assert.equal(r.config.queue.sweepIntervalSeconds, 120);
  assert.equal(r.config.queue.spool.enabled, true);
  assert.equal(r.config.toolSummary.payloadMaxBytes, 1048576);
  // 落盘后可读回
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8'));
  assert.equal(onDisk.queue.toolGroupMax, 3);
  assert.equal(onDisk.toolSummary.payloadMaxBytes, 1048576);
} finally { serverHandle.close(); fs.rmSync(dir,{recursive:true}); } });

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

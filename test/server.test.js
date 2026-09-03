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

#!/usr/bin/env bash
# cw-mem: Stop hook handler
# stdin JSON (spec §2.1): { session_id, prompt_id, cwd, hook_event_name, last_assistant_message }
#
# 行为:
#   1. POST /api/prompts/response 把最终回复写回 PROMPT 行
#   2. POST /api/prompts/summarize 入队(服务端 Stop 批量: tool 观察 + result 摘要 + 向量化)
#   3. stdout: {continue:true, suppressOutput:true}
# 闭环: result 摘要 mandatory, 服务端在 LLM 不可用时落 failed 状态, 不丢闭环。

set -u

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")"/.. && pwd)}"
export SERVER_URL="${SERVER_URL:-http://localhost:37889}"
export CW_MEM_DATA_DIR="${CW_MEM_DATA_DIR:-$HOME/.cw-mem}"

RAW_JSON="$(cat)"

CW_MEM_LOG_JS="$PLUGIN_ROOT/hooks-handlers/_log.js" \
CW_MEM_RAW_JSON="$RAW_JSON" node -e "
const http = require('http');
const log = require(process.env.CW_MEM_LOG_JS);
const raw = process.env.CW_MEM_RAW_JSON || '';
let data = {};
try { data = JSON.parse(raw); } catch(e) { log.warn('STOP stdin parse failed: ' + e.message); }
const session_id = data.session_id || '';
const prompt_id = data.prompt_id || '';
const response = data.last_assistant_message || '';
log.debug('STOP: session=' + session_id + ', prompt_id=' + prompt_id + ', response_len=' + response.length);
log.info('STOP received: session=' + session_id + ', prompt_id=' + prompt_id + ', response=' + log.trunc(response));

function port() { return parseInt(new URL(process.env.SERVER_URL).port, 10) || 37889; }
function post(path, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request({ hostname:'127.0.0.1', port: port(), path, method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)} }, (res) => {
      let b=''; res.on('data', c => b += c); res.on('end', () => {
        let parsed = {}; try { parsed = JSON.parse(b); } catch(e) { parsed = {}; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300 && !parsed.error, body: b, changes: parsed.changes });
      });
    });
    const timer = setTimeout(() => { req.destroy(); resolve({ ok:false, body:'' }); }, 5000);
    req.on('error', () => { clearTimeout(timer); resolve({ ok:false, body:'' }); });
    req.write(payload); req.end();
  });
}
function suppress() { console.log(JSON.stringify({ continue: true, suppressOutput: true })); }

(async () => {
  if (!prompt_id || !response) {
    log.warn('STOP missing prompt_id or empty response, skipped');
    suppress(); process.exit(0);
  }
  const r = await post('/api/prompts/response', { sessionId: session_id, promptId: prompt_id, response: response });
  log.info('STOP response ' + (r.ok ? 'recorded changes=' + (r.changes!=null?r.changes:'-') : 'write FAILED') + ': session=' + session_id);
  if (r.ok) {
    const s = await post('/api/prompts/summarize', { sessionId: session_id, promptId: prompt_id });
    log.debug('POST /api/prompts/summarize: ok=' + s.ok + ', body=' + (s.body||''));
  }
  suppress();
})().catch((e) => { log.warn('STOP error: ' + (e.message||e)); suppress(); });
"

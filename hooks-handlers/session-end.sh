#!/usr/bin/env bash
# memory-lite: SessionEnd hook handler
# stdin JSON (spec §2.1): { session_id, transcript_path, cwd, prompt_id, hook_event_name, reason }
#
# 行为:
#   1. POST /api/sessions/summarize { sessionId, reason } 触发会话级摘要(T10 接入)
#   2. stdout: {continue:true, suppressOutput:true}
# 闭环: session 摘要 mandatory, 服务端聚合本轮所有 PROMPT result 摘要 + 向量化。

set -u

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")"/.. && pwd)}"
export SERVER_URL="${SERVER_URL:-http://localhost:37889}"
export MEMORY_LITE_DATA_DIR="${MEMORY_LITE_DATA_DIR:-$HOME/.memory-lite}"

RAW_JSON="$(cat)"

MEMORY_LITE_LOG_JS="$PLUGIN_ROOT/hooks-handlers/_log.js" \
MEMORY_LITE_RAW_JSON="$RAW_JSON" node -e "
const http = require('http');
const log = require(process.env.MEMORY_LITE_LOG_JS);
const raw = process.env.MEMORY_LITE_RAW_JSON || '';
let data = {};
try { data = JSON.parse(raw); } catch(e) { log.warn('SessionEnd stdin parse failed: ' + e.message); }
const session_id = data.session_id || '';
const cwd = data.cwd || '';
const reason = data.reason || '';
log.debug('SessionEnd: session=' + session_id + ', reason=' + reason + ', cwd=' + cwd);
log.info('SessionEnd received: session=' + session_id + ', reason=' + reason);

function port() { return parseInt(new URL(process.env.SERVER_URL).port, 10) || 37889; }
function post(path, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request({ hostname:'127.0.0.1', port: port(), path, method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)} }, (res) => {
      let b=''; res.on('data', c => b += c); res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, body: b }));
    });
    const timer = setTimeout(() => { req.destroy(); resolve({ ok:false, body:'' }); }, 5000);
    req.on('error', () => { clearTimeout(timer); resolve({ ok:false, body:'' }); });
    req.write(payload); req.end();
  });
}
function suppress() { console.log(JSON.stringify({ continue: true, suppressOutput: true })); }

(async () => {
  if (!session_id) { log.warn('SessionEnd missing session_id, skipped'); suppress(); process.exit(0); }
  const r = await post('/api/sessions/summarize', { sessionId: session_id, reason: reason });
  log.info('SessionEnd ' + (r.ok ? 'summarize queued' : 'summarize FAILED') + ': session=' + session_id);
  suppress();
})().catch((e) => { log.warn('SessionEnd error: ' + (e.message||e)); suppress(); });
"

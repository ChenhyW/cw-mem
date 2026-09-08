#!/usr/bin/env bash
# cw-mem: SessionEnd hook handler
# stdin JSON (spec §2.1): { session_id, transcript_path, cwd, prompt_id, hook_event_name, reason }
#
# 行为:
#   1. POST /api/sessions/summarize { sessionId, reason } 触发会话级摘要(T10 接入)
#   2. stdout: {continue:true, suppressOutput:true}
# 闭环: session 摘要 mandatory, 服务端聚合本轮所有 PROMPT result 摘要 + 向量化。

set -u

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")"/.. && pwd)}"
export SERVER_URL="${SERVER_URL:-http://localhost:37889}"
export CW_MEM_DATA_DIR="${CW_MEM_DATA_DIR:-$HOME/.cw-mem}"

source "$(dirname "$0")/_log.sh"
source "$(dirname "$0")/_spool.sh"

RAW_JSON="$(cat)"

CW_MEM_LOG_JS="$PLUGIN_ROOT/hooks-handlers/_log.js" \
CW_MEM_PENDING_SPOOL="$CW_MEM_DATA_DIR/.spool-pending.$$" \
CW_MEM_RAW_JSON="$RAW_JSON" node -e "
const http = require('http');
const log = require(process.env.CW_MEM_LOG_JS);
const raw = process.env.CW_MEM_RAW_JSON || '';
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
// 记下失败记录, node 块结束后由 bash 侧 drain_pending_spool 统一判定是否落 spool
function remember(path, body) {
  try {
    fs.appendFileSync(process.env.CW_MEM_PENDING_SPOOL || '/dev/null',
      path + '\t' + JSON.stringify(body) + '\n', 'utf8');
  } catch(e) {}
}

(async () => {
  if (!session_id) { log.warn('SessionEnd missing session_id, skipped'); suppress(); process.exit(0); }
  const body = { sessionId: session_id, reason: reason };
  const r = await post('/api/sessions/summarize', body);
  log.info('SessionEnd ' + (r.ok ? 'summarize queued' : 'summarize FAILED') + ': session=' + session_id);
  // 失败要兜底: ended_at 不落库, 下次启动的 recover() 就扫不到这个会话
  if (!r.ok) remember('/api/sessions/summarize', body);
  suppress();
})().catch((e) => { log.warn('SessionEnd error: ' + (e.message||e)); suppress(); });
"

# 失败记录交给 _spool.sh 统一判定是否落本地兜底(queue.spool.enabled 关闭时丢弃)
drain_pending_spool "$CW_MEM_DATA_DIR/.spool-pending.$$"

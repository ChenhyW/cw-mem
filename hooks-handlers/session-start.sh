#!/usr/bin/env bash
# cw-mem: SessionStart hook handler
# stdin JSON (spec §2.1): { session_id, cwd }
#
# 行为:
#   1. 确保 server 运行(lazy-start), 同步写 session(5s 超时, 保证后续 hook 有 session 行)
#   2. GET /api/recall/session?project=<cwd> 取最近 N 条会话摘要作注入
#   3. stdout: 注入走 hookSpecificOutput.additionalContext(模型消费);
#      无内容时只发 systemMessage banner(用户可见, 不注入)
#
# 闭环: SessionStart 注入是 mandatory, 即使无历史也发 banner 让用户知道已生效。
# node 块的 stdout 即 hook stdout(不重定向), 最终 JSON 必须由 node 打印。

set -u

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
export SERVER_URL="${SERVER_URL:-http://localhost:37889}"
SERVER_JS="$PLUGIN_ROOT/lib/server.js"
DATA_DIR="${CW_MEM_DATA_DIR:-$HOME/.cw-mem}"
export CW_MEM_DATA_DIR="$DATA_DIR"
mkdir -p "$DATA_DIR"

source "$(dirname "$0")/_log.sh"

SESSION_JSON="$(cat)"

SESSION_ID="$(node -e "const i=process.argv[1]; try{const d=JSON.parse(i); process.stdout.write(d.session_id||'')}catch(e){}" "$SESSION_JSON")"
CWD="$(node -e "const i=process.argv[1]; try{const d=JSON.parse(i); process.stdout.write(d.cwd||'')}catch(e){}" "$SESSION_JSON")"

log_info "SessionStart received: session=$SESSION_ID, cwd=$CWD"

# 确保 server 运行
if ! curl -s --max-time 2 "$SERVER_URL/api/health" > /dev/null 2>&1; then
  log_info "server not running, starting..."
  nohup node "$SERVER_JS" "$DATA_DIR" "$PLUGIN_ROOT/ui" > "$DATA_DIR/server.log" 2>&1 &
  for i in $(seq 1 10); do
    if curl -s --max-time 1 "$SERVER_URL/api/health" > /dev/null 2>&1; then break; fi
    sleep 0.5
  done
  if curl -s --max-time 1 "$SERVER_URL/api/health" > /dev/null 2>&1; then
    log_info "server started"
  else
    log_warn "server failed to start within 5s"
  fi
fi

# 写 session + 取注入 + 打印最终 stdout JSON(node stdout = hook stdout)
CW_MEM_LOG_JS="$PLUGIN_ROOT/hooks-handlers/_log.js" \
CW_MEM_RAW_JSON="$SESSION_JSON" node -e "
const http = require('http');
const log = require(process.env.CW_MEM_LOG_JS);
const raw = process.env.CW_MEM_RAW_JSON || '';
let data = {};
try { data = JSON.parse(raw); } catch(e) { log.warn('stdin parse failed: ' + e.message); }
const sessionId = data.session_id || '';
const cwd = data.cwd || '';

function port() { return parseInt(new URL(process.env.SERVER_URL).port, 10) || 37889; }
function get(path) {
  return new Promise((resolve) => {
    const req = http.get({ hostname:'127.0.0.1', port: port(), path, timeout: 5000 }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, body: b }));
    });
    req.on('error', () => resolve({ ok:false, body:'' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok:false, body:'' }); });
  });
}
function post(path, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request({ hostname:'127.0.0.1', port: port(), path, method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)} }, (res) => {
      let b=''; res.on('data', c => b += c); res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, body:b }));
    });
    const timer = setTimeout(() => { req.destroy(); resolve({ ok:false, body:'' }); }, 5000);
    req.on('error', () => { clearTimeout(timer); resolve({ ok:false, body:'' }); });
    req.write(payload); req.end();
  });
}
function emitBanner() {
  console.log(JSON.stringify({ systemMessage: '🧠 cw-mem 已生效 — 提示词自动记录中, UI: http://localhost:37889' }));
}
function emitInjection(text) {
  if (text && String(text).trim()) {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text }, systemMessage: '🧠 cw-mem 已生效 — 已注入过往会话摘要' }));
  } else { emitBanner(); }
}

(async () => {
  if (!sessionId) { log.warn('missing session_id'); emitBanner(); return; }
  try {
    await post('/api/sessions', { sessionId: sessionId, projectDir: cwd });
    log.info('session written: ' + sessionId);
  } catch(e) { log.warn('session write failed: ' + (e.message||e)); }
  try {
    const r = await get('/api/recall/session?project=' + encodeURIComponent(cwd));
    if (r.ok) {
      let text = '';
      try { text = JSON.parse(r.body || '{}').text || ''; } catch(e) { text = ''; }
      emitInjection(text);
    } else { emitBanner(); }
  } catch(e) { log.warn('recall/session failed: ' + (e.message||e)); emitBanner(); }
})().catch((e) => { log.warn('SessionStart error: ' + (e.message||e)); emitBanner(); });
"

log_cleanup

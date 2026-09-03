#!/usr/bin/env bash
# cw-mem: UserPromptSubmit hook handler
# stdin JSON (spec §2.1): { session_id, prompt, prompt_id, cwd, source, transcript_path, permission_mode, hook_event_name }
#
# 行为:
#   1. 同步 POST /api/sessions(确保) + POST /api/prompts(type=PROMPT)
#   2. POST /api/recall/semantic {promptId, sessionId, project:cwd, prompt} → {text, hits}
#      服务端把 injected_context 写回 PROMPT 行
#   3. stdout: 有注入文本 → hookSpecificOutput.additionalContext; 无 → continue+suppress
# 闭环: UserPromptSubmit 注入是 mandatory。超时/失败静默, 不阻塞 Claude。

set -u

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
export SERVER_URL="${SERVER_URL:-http://localhost:37889}"
export CW_MEM_DATA_DIR="${CW_MEM_DATA_DIR:-$HOME/.cw-mem}"

CW_MEM_LOG_JS="$PLUGIN_ROOT/hooks-handlers/_log.js" node -e "
const http = require('http');
const log = require(process.env.CW_MEM_LOG_JS);
const input = require('fs').readFileSync('/dev/stdin', 'utf8').trim();
let data = {};
try { data = JSON.parse(input); } catch(e) { log.warn('stdin parse failed: ' + e.message); }
const SESSION_ID = data.session_id || 'unknown';
const PROMPT = data.prompt || data.user_prompt || '';
const CWD = data.cwd || '';
const PROMPT_ID = data.prompt_id || '';
const SOURCE = data.source || '';
log.debug('UserPromptSubmit keys: ' + Object.keys(data).join(','));
log.info('UserPromptSubmit received: session=' + SESSION_ID + ', prompt_id=' + PROMPT_ID + ', source=' + SOURCE + ', prompt=' + log.trunc(PROMPT));

function port() { return parseInt(new URL(process.env.SERVER_URL).port, 10) || 37889; }
function post(path, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request({ hostname:'127.0.0.1', port: port(), path, method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)} }, (res) => {
      let b=''; res.on('data', c => b += c); res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(b); } catch(e) { parsed = {}; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300 && !parsed.error, body: b, id: parsed.id, text: parsed.text, hits: parsed.hits });
      });
    });
    const timer = setTimeout(() => { req.destroy(); resolve({ ok:false, body:'' }); }, 5000);
    req.on('error', () => { clearTimeout(timer); resolve({ ok:false, body:'' }); });
    req.write(payload); req.end();
  });
}
function suppress() { console.log(JSON.stringify({ continue: true, suppressOutput: true })); }

(async () => {
  if (!PROMPT) { log.warn('empty prompt, skipped'); suppress(); process.exit(0); }
  await post('/api/sessions', { sessionId: SESSION_ID, projectDir: CWD });
  const r = await post('/api/prompts', { sessionId: SESSION_ID, prompt: PROMPT, type:'PROMPT', claudePromptId: PROMPT_ID, projectDir: CWD });
  log.info('prompt ' + (r.ok ? 'recorded id=' + (r.id||'-') : 'write FAILED') + ': session=' + SESSION_ID);
  // 语义召回 + 注入
  const s = await post('/api/recall/semantic', { promptId: PROMPT_ID, sessionId: SESSION_ID, project: CWD, prompt: PROMPT });
  if (s.ok && s.text && String(s.text).trim()) {
    log.info('injection: ' + (s.hits ? s.hits.length : 0) + ' hits, ' + s.text.length + ' chars');
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: s.text } }));
  } else {
    log.debug('no injection (text empty or recall failed)');
    suppress();
  }
})().catch((e) => { log.warn('UserPromptSubmit error: ' + (e.message||e)); suppress(); });
"

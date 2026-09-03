#!/usr/bin/env bash
# memory-lite: PostToolUse hook handler
# stdin JSON (spec §2.1):
#   { session_id, prompt_id, cwd, tool_name, tool_use_id, duration_ms,
#     tool_input, tool_response{ stdout, stderr, interrupted, isImage, noOutputExpected } }
#   (无 tool_output / exit_code; 错误靠 tool_response.stderr 判断)
#
# 行为:
#   1. 读 config.toolSummary.enabled; 若 false → suppress 退出(不记原始 tool I/O)
#   2. 同步 POST /api/sessions + POST /api/prompts(type=TOOL) + POST /api/tool-details
#   3. (不在此做 LLM; Stop 批量统一处理)
#   4. stdout: {continue:true, suppressOutput:true}
# 闭环可选项: toolSummary.enabled 决定是否记录工具调用。关闭时跳过整条, 省 token。

set -u

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")"/.. && pwd)}"
export SERVER_URL="${SERVER_URL:-http://localhost:37889}"
export MEMORY_LITE_DATA_DIR="${MEMORY_LITE_DATA_DIR:-$HOME/.memory-lite}"

source "$(dirname "$0")/_log.sh"

RAW_JSON="$(cat)"

# 轮转备份原始 payload (最多 3 份), 失败不阻塞
node -e "
const fs = require('fs');
const raw = process.argv[1];
const base = (process.env.MEMORY_LITE_DATA_DIR || process.env.HOME + '/.memory-lite') + '/posttooluse-raw.json';
try {
  fs.mkdirSync(require('path').dirname(base), { recursive: true });
  const p1 = base + '.2'; if (fs.existsSync(p1)) fs.unlinkSync(p1);
  const p2 = base + '.1'; if (fs.existsSync(p2)) fs.renameSync(p2, p1);
  if (fs.existsSync(base)) fs.renameSync(base, p2);
  fs.writeFileSync(base, raw, 'utf8');
} catch(e) {}
" "$RAW_JSON" 2>/dev/null || true

MEMORY_LITE_LOG_JS="$PLUGIN_ROOT/hooks-handlers/_log.js" \
MEMORY_LITE_RAW_JSON="$RAW_JSON" node -e "
const http = require('http');
const fs = require('fs');
const path = require('path');
const log = require(process.env.MEMORY_LITE_LOG_JS);
const raw = process.env.MEMORY_LITE_RAW_JSON || '';
let data = {};
try { data = JSON.parse(raw); } catch(e) { log.warn('stdin parse failed: ' + e.message); }

const session_id = data.session_id || '';
const prompt_id = data.prompt_id || '';
const cwd = data.cwd || '';
const tool_name = data.tool_name || '';
const tool_use_id = data.tool_use_id || '';
const duration_ms = data.duration_ms || '';
const resp = data.tool_response || {};
log.debug('PostToolUse: session=' + session_id + ', prompt_id=' + prompt_id + ', tool=' + tool_name + ', dur=' + duration_ms + 'ms');

function port() { return parseInt(new URL(process.env.SERVER_URL).port, 10) || 37889; }
function post(path, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request({ hostname:'127.0.0.1', port: port(), path, method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)} }, (res) => {
      let b=''; res.on('data', c => b += c); res.on('end', () => {
        let parsed = {}; try { parsed = JSON.parse(b); } catch(e) { parsed = {}; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300 && !parsed.error, body: b, id: parsed.id });
      });
    });
    const timer = setTimeout(() => { req.destroy(); resolve({ ok:false, body:'' }); }, 5000);
    req.on('error', () => { clearTimeout(timer); resolve({ ok:false, body:'' }); });
    req.write(payload); req.end();
  });
}
function suppress() { console.log(JSON.stringify({ continue: true, suppressOutput: true })); }

(async () => {
  if (!tool_name) { log.warn('PostToolUse missing tool_name, skipped'); suppress(); process.exit(0); }

  // ── 读 config.toolSummary.enabled ──
  const cfgPath = path.join(process.env.MEMORY_LITE_DATA_DIR || (process.env.HOME||'') + '/.memory-lite', 'config.json');
  let toolSummaryEnabled = false;
  if (fs.existsSync(cfgPath)) {
    try {
      const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (c.toolSummary && typeof c.toolSummary.enabled === 'boolean') toolSummaryEnabled = c.toolSummary.enabled;
    } catch(e) { log.warn('config read failed: ' + e.message); }
  }
  if (!toolSummaryEnabled) {
    log.debug('tool recording disabled (toolSummary.enabled=false), skipped: tool=' + tool_name);
    suppress(); process.exit(0);
  }

  // ── 确保 session + 写 TOOL prompt + tool_details ──
  const sessR = await post('/api/sessions', { sessionId: session_id, projectDir: cwd });
  if (!sessR.ok) { log.warn('session ensure FAILED (server unreachable)'); suppress(); process.exit(0); }

  const promptBody = {
    sessionId: session_id,
    prompt: tool_name + ': ' + (resp.stdout || '').slice(0, 200),
    type: 'TOOL',
    toolName: tool_name,
    projectDir: cwd,
    claudePromptId: prompt_id
  };
  const r1 = await post('/api/prompts', promptBody);
  if (!r1.ok) { log.warn('tool prompt write FAILED: tool=' + tool_name); suppress(); process.exit(0); }
  const prompt_id_db = r1.id;

  const td = {
    promptId: prompt_id_db,
    toolInput: data.tool_input || null,
    toolOutput: {
      stdout: resp.stdout || '',
      stderr: resp.stderr || '',
      interrupted: resp.interrupted || false,
      isImage: resp.isImage || false,
      noOutputExpected: resp.noOutputExpected || false
    },
    toolUseId: tool_use_id,
    toolName: tool_name,
    durationMs: duration_ms
  };
  const r2 = await post('/api/tool-details', td);
  if (!r2.ok) { log.warn('tool_details write FAILED: prompt_id=' + prompt_id_db); }

  log.info('PostToolUse recorded id=' + prompt_id_db + ': tool=' + tool_name + ' (' + duration_ms + 'ms)');
  suppress();
})().catch((e) => { log.warn('PostToolUse error: ' + (e.message||e)); suppress(); });
"

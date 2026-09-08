#!/usr/bin/env bash
# cw-mem: PostToolUse hook handler
# stdin JSON (spec §2.1):
#   { session_id, prompt_id, cwd, tool_name, tool_use_id, duration_ms,
#     tool_input, tool_response{ stdout, stderr, interrupted, isImage, noOutputExpected } }
#   (无 tool_output / exit_code; 错误靠 tool_response.stderr 判断)
#
# 行为:
#   1. 读 config.toolSummary.enabled; 若 false → suppress 退出(不记原始 tool I/O)
#   2. skipMode='on' 时记录层硬跳过低信号工具(见 lib/skip.js)
#   3. server 不存活 → ensure_server 3s 尝试拉起
#   4. 同步 POST /api/sessions + POST /api/prompts(type=TOOL, 带 filePath 复合键)
#      + POST /api/tool-details; 任一失败记入 pending, 由 drain_pending_spool 兜底
#   5. (不在此做 LLM; 队列侧按 (tool_name, file_path) 流式聚合)
#   6. stdout: {continue:true, suppressOutput:true}
# 闭环可选项: toolSummary.enabled 决定是否记录工具调用。关闭时跳过整条, 省 token。

set -u

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")"/.. && pwd)}"
export SERVER_URL="${SERVER_URL:-http://localhost:37889}"
export CW_MEM_DATA_DIR="${CW_MEM_DATA_DIR:-$HOME/.cw-mem}"

source "$(dirname "$0")/_log.sh"
source "$(dirname "$0")/_spool.sh"
source "$(dirname "$0")/_ensure_server.sh"

RAW_JSON="$(cat)"

# server 不存活时给 3s 尝试拉起; 仍失败则本次记录走 spool 兜底。
# 探活本身 1s 上限, server 存活时本分支零开销。
if ! curl -s --max-time 1 "$SERVER_URL/api/health" > /dev/null 2>&1; then
  ensure_server 3 || log_warn "server unavailable, records will be spooled"
fi

# 轮转备份原始 payload (最多 3 份), 失败不阻塞
node -e "
const fs = require('fs');
const raw = process.argv[1];
const base = (process.env.CW_MEM_DATA_DIR || process.env.HOME + '/.cw-mem') + '/posttooluse-raw.json';
try {
  fs.mkdirSync(require('path').dirname(base), { recursive: true });
  const p1 = base + '.2'; if (fs.existsSync(p1)) fs.unlinkSync(p1);
  const p2 = base + '.1'; if (fs.existsSync(p2)) fs.renameSync(p2, p1);
  if (fs.existsSync(base)) fs.renameSync(base, p2);
  fs.writeFileSync(base, raw, 'utf8');
} catch(e) {}
" "$RAW_JSON" 2>/dev/null || true

CW_MEM_LOG_JS="$PLUGIN_ROOT/hooks-handlers/_log.js" \
CW_MEM_SKIP_JS="$PLUGIN_ROOT/lib/skip.js" \
CW_MEM_PENDING_SPOOL="$CW_MEM_DATA_DIR/.spool-pending.$$" \
CW_MEM_RAW_JSON="$RAW_JSON" node -e "
const http = require('http');
const fs = require('fs');
const path = require('path');
const log = require(process.env.CW_MEM_LOG_JS);
const isLowSignalTool = require(process.env.CW_MEM_SKIP_JS).isLowSignalTool;
const raw = process.env.CW_MEM_RAW_JSON || '';
let data = {};
try { data = JSON.parse(raw); } catch(e) { log.warn('stdin parse failed: ' + e.message); }

const session_id = data.session_id || '';
const prompt_id = data.prompt_id || '';
const cwd = data.cwd || '';
const tool_name = data.tool_name || '';
const tool_use_id = data.tool_use_id || '';
const duration_ms = data.duration_ms || '';
const resp = data.tool_response || {};
const tool_input = data.tool_input || {};
// 复合键 file_path: Edit/Write/NotebookEdit 用 file_path, Write 用 path; 其余工具无 → 空串
// (server 端退化为按工具名聚合)。不从 Bash command 正则提文件名: 解析不可靠。
const filePath = tool_input.file_path || tool_input.path || '';
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
// 记下失败记录, node 块结束后由 bash 侧 drain_pending_spool 统一判定是否落 spool
function remember(path, body) {
  try {
    fs.appendFileSync(process.env.CW_MEM_PENDING_SPOOL || '/dev/null',
      path + '\t' + JSON.stringify(body) + '\n', 'utf8');
  } catch(e) {}
}

(async () => {
  if (!tool_name) { log.warn('PostToolUse missing tool_name, skipped'); suppress(); process.exit(0); }

  // ── 读 config.toolSummary.enabled + skipMode ──
  const cfgPath = path.join(process.env.CW_MEM_DATA_DIR || (process.env.HOME||'') + '/.cw-mem', 'config.json');
  let toolSummaryEnabled = false;
  let skipMode = 'on';
  if (fs.existsSync(cfgPath)) {
    try {
      const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (c.toolSummary && typeof c.toolSummary.enabled === 'boolean') toolSummaryEnabled = c.toolSummary.enabled;
      if (c.toolSummary && (c.toolSummary.skipMode === 'on' || c.toolSummary.skipMode === 'off')) skipMode = c.toolSummary.skipMode;
    } catch(e) { log.warn('config read failed: ' + e.message); }
  }
  if (!toolSummaryEnabled) {
    log.debug('tool recording disabled (toolSummary.enabled=false), skipped: tool=' + tool_name);
    suppress(); process.exit(0);
  }
  // skipMode='on' 时记录层硬跳过低信号工具(纯读取/搜索/只读Bash/静默Bash), 省 DB 写入与后续 LLM 摘要
  if (skipMode === 'on' && isLowSignalTool({ tool_name, tool_input: data.tool_input, tool_response: resp })) {
    log.debug('low-signal tool skipped (skipMode=on): tool=' + tool_name);
    suppress(); process.exit(0);
  }

  // ── 确保 session + 写 TOOL prompt + tool_details ──
  // 先把三个 body 全构造出来: server 不可达时一次性全进 spool, 不逐个重试
  // (每次 POST 最长 5s 超时, 而 PostToolUse 在用户热路径上)。
  const sessBody = { sessionId: session_id, projectDir: cwd };
  const promptBody = {
    sessionId: session_id,
    prompt: tool_name + ': ' + (resp.stdout || '').slice(0, 200),
    type: 'TOOL',
    toolName: tool_name,
    toolUseId: tool_use_id,
    projectDir: cwd,
    claudePromptId: prompt_id,
    filePath: filePath
  };
  const td = {
    promptId: null,                 // 待 /api/prompts 返回自增 id 后填; spool 场景下可能为空
    sessionId: session_id,
    filePath: filePath,
    toolInput: tool_input || null,
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

  const sessR = await post('/api/sessions', sessBody);
  if (!sessR.ok) {
    log.warn('server unreachable, spooling all records: tool=' + tool_name);
    remember('/api/sessions', sessBody);
    remember('/api/prompts', promptBody);
    remember('/api/tool-details', td);
    suppress(); process.exit(0);
  }

  const r1 = await post('/api/prompts', promptBody);
  if (!r1.ok) {
    log.warn('tool prompt write FAILED: tool=' + tool_name);
    remember('/api/prompts', promptBody);
    remember('/api/tool-details', td);
    suppress(); process.exit(0);
  }
  td.promptId = r1.id;

  const r2 = await post('/api/tool-details', td);
  if (!r2.ok) {
    log.warn('tool_details write FAILED: prompt_id=' + td.promptId);
    remember('/api/tool-details', td);
  }

  log.info('PostToolUse recorded id=' + td.promptId + ': tool=' + tool_name + ' (' + duration_ms + 'ms)');
  suppress();
})().catch((e) => { log.warn('PostToolUse error: ' + (e.message||e)); suppress(); });
"

# 失败记录交给 _spool.sh 统一判定是否落本地兜底(queue.spool.enabled 关闭时丢弃)
drain_pending_spool "$CW_MEM_DATA_DIR/.spool-pending.$$"

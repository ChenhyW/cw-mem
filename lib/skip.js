// lib/skip.js — cw-mem 记录层低信号工具跳过(skipMode='on' 时生效)。
//
// 纯函数, 无依赖, 供 post-tool-use hook 与测试复用。
// 目的: 纯读取/重复状态检查/空输出的工具调用直接不记, 省 DB 写入与后续 LLM 摘要调用。
// 仅判定"显然无长期记忆价值"的调用; 边界 case 仍交给 LLM 软 skip。
//
// skipMode:
//   'on'  → 记录层硬跳过(本模块) + LLM 软 skip(模板指示)
//   'off' → 全记录, 只靠 LLM 软 skip

// 硬跳过: 纯列表/搜索/待办类工具(几乎无长期记忆价值)
const HARD_SKIP_TOOLS = new Set(['LS', 'Glob', 'Grep', 'TodoWrite']);

// 只读 Bash 命令(取管道/分隔符前首个命令判断)
const READONLY_BINARIES = new Set([
  'ls', 'll', 'la', 'cat', 'head', 'tail', 'less', 'more', 'pwd', 'find', 'grep',
  'rg', 'ag', 'wc', 'which', 'where', 'file', 'stat', 'du', 'df', 'env', 'printenv',
  'echo', 'printf', 'uname', 'whoami', 'id', 'date', 'cal', 'diff', 'comm', 'cut',
  'sort', 'uniq', 'tr', 'seq', 'test', 'true'
]);
// git 的只读子命令(其余 git 子命令如 commit/push 等不跳过)
const READONLY_GIT_SUB = new Set([
  'status', 'log', 'branch', 'diff', 'show', 'stash', 'list', 'ls-files',
  'ls-remote', 'remote', 'rev-parse', 'describe', 'reflog', 'shortlog', 'blame'
]);

// 取管道/;/&&/|| 前的首个命令片段
function firstCommand(cmd) {
  const c = String(cmd || '').trim();
  if (!c) return '';
  const seg = c.split(/[|;&]|\|\||&&/).map(s => s.trim()).filter(Boolean)[0] || '';
  return seg;
}

function isReadOnlyBash(cmd) {
  const seg = firstCommand(cmd);
  if (!seg) return false;
  const parts = seg.split(/\s+/);
  const name = parts[0].replace(/^.*\//, '');  // 去掉路径前缀
  if (name === 'git') {
    return READONLY_GIT_SUB.has(parts[1]);
  }
  return READONLY_BINARIES.has(name);
}

function isEmptyOutput(resp) {
  if (!resp) return true;
  if (resp.noOutputExpected) return true;
  const so = (resp.stdout == null ? '' : String(resp.stdout)).trim();
  const se = (resp.stderr == null ? '' : String(resp.stderr)).trim();
  return !so && !se;
}

// 是否低信号工具调用(记录层跳过)。仅 skipMode='on' 时由调用方使用。
// 入参: { tool_name, tool_input, tool_response }
function isLowSignalTool({ tool_name, tool_input, tool_response } = {}) {
  if (!tool_name) return false;
  if (HARD_SKIP_TOOLS.has(tool_name)) return true;
  if (tool_name === 'Bash') {
    const cmd = tool_input && tool_input.command;
    if (isReadOnlyBash(cmd)) return true;
    if (isEmptyOutput(tool_response)) return true;  // 静默 Bash(无 stdout/stderr)
  }
  return false;
}

module.exports = {
  isLowSignalTool,
  isReadOnlyBash,
  firstCommand,
  isEmptyOutput,
  HARD_SKIP_TOOLS,
  READONLY_BINARIES,
  READONLY_GIT_SUB
};

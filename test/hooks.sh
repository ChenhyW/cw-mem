#!/usr/bin/env bash
# cw-mem hook 层测试 (spool / ensure_server / drain_pending_spool)。
# 由 test/hooks.test.js 以 `bash test/hooks.sh <case>` 调用。
#
# 不依赖 server 是否存活: SERVER_URL 指向必死的 127.0.0.1:1, 保证 POST 一定失败。
# 每个用例用独立的 mkdtemp 目录做 CW_MEM_DATA_DIR, 结束后清理, 互不干扰。

set -u

ROOT="$(cd "$(dirname "$0")"/.. && pwd)"
export PLUGIN_ROOT="$ROOT"
export SERVER_URL="http://127.0.0.1:1"

source "$ROOT/hooks-handlers/_log.sh"
source "$ROOT/hooks-handlers/_spool.sh"
source "$ROOT/hooks-handlers/_ensure_server.sh"

PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); echo "  PASS $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }

fresh_dir() {
  CW_MEM_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hooksd.XXXXXX")"
  export CW_MEM_DATA_DIR
}
cleanup() {
  [ -n "${CW_MEM_DATA_DIR:-}" ] && [ -d "$CW_MEM_DATA_DIR" ] && rm -rf "$CW_MEM_DATA_DIR"
}

# spool 关闭时: 失败即丢弃, 连目录都不建
case_spool_disabled() {
  fresh_dir
  echo '{"queue":{"spool":{"enabled":false}}}' > "$CW_MEM_DATA_DIR/config.json"
  spool "/api/tool-details" '{"promptId":1}'
  if [ -d "$CW_MEM_DATA_DIR/spool" ]; then
    bad "disabled: 未开启时不应创建 spool 目录"
  else
    ok "disabled: 未开启时丢弃, 不建目录"
  fi
  cleanup
}

# spool 开启时: 写成 {path, body} 的 JSONL
case_spool_enabled() {
  fresh_dir
  echo '{"queue":{"spool":{"enabled":true}}}' > "$CW_MEM_DATA_DIR/config.json"
  spool "/api/tool-details" '{"promptId":1,"toolName":"Write"}'
  local f
  f="$(ls "$CW_MEM_DATA_DIR/spool" 2>/dev/null | head -1)"
  if [ -z "$f" ]; then
    bad "enabled: 未生成 spool 文件"
    cleanup
    return
  fi
  if node -e "
const rec = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8').trim());
const good = rec.path === '/api/tool-details' && rec.body
  && rec.body.promptId === 1 && rec.body.toolName === 'Write';
process.exit(good ? 0 : 1);
" "$CW_MEM_DATA_DIR/spool/$f" 2>/dev/null; then
    ok "enabled: 记录 path/body 结构正确"
  else
    bad "enabled: 记录内容不符: $(cat "$CW_MEM_DATA_DIR/spool/$f")"
  fi
  cleanup
}

# config 缺失 / malformed 一律按"关闭"处理 —— 切不可"出错反而 spool"
case_spool_no_config() {
  fresh_dir
  spool "/api/tool-details" '{"promptId":1}'
  if [ -d "$CW_MEM_DATA_DIR/spool" ]; then
    bad "no-config: config 缺失时应丢弃"
  else
    ok "no-config: config 缺失时丢弃"
  fi
  cleanup

  fresh_dir
  echo '{not valid json' > "$CW_MEM_DATA_DIR/config.json"
  spool "/api/tool-details" '{"promptId":1}'
  if [ -d "$CW_MEM_DATA_DIR/spool" ]; then
    bad "malformed: malformed config 时应丢弃(否则会骗用户以为开了兜底)"
  else
    ok "malformed: malformed config 时丢弃"
  fi
  cleanup
}

# drain_pending_spool: 逐条 spool 并用掉临时文件
case_drain_pending() {
  fresh_dir
  echo '{"queue":{"spool":{"enabled":true}}}' > "$CW_MEM_DATA_DIR/config.json"
  local pending="$CW_MEM_DATA_DIR/.pending"
  printf '/api/prompts/response\t{"sessionId":"s1","promptId":"cp1","response":"resp"}\n' > "$pending"
  printf '/api/sessions/summarize\t{"sessionId":"s1","reason":"clear"}\n' >> "$pending"
  drain_pending_spool "$pending"

  if [ -e "$pending" ]; then
    bad "drain: 临时文件应被删除"
  else
    ok "drain: 临时文件已删除"
  fi

  local total
  total="$(cat "$CW_MEM_DATA_DIR"/spool/*.jsonl 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$total" = "2" ]; then
    ok "drain: 两条记录均已落盘"
  else
    bad "drain: 期望 2 条, 实际 ${total:-0}"
  fi
  cleanup
}

# 空 pending 文件: 纯 no-op
case_drain_empty() {
  fresh_dir
  local pending="$CW_MEM_DATA_DIR/.pending"
  : > "$pending"
  drain_pending_spool "$pending"
  if [ -d "$CW_MEM_DATA_DIR/spool" ]; then
    bad "drain-empty: 空 pending 不应创建 spool 目录"
  else
    ok "drain-empty: 空 pending 是 no-op"
  fi
  cleanup
}

# ensure_server: 拉不起时如实返回 1, 不谎报成功
case_ensure_server_down() {
  fresh_dir
  SERVER_JS="$CW_MEM_DATA_DIR/no-such-server.js"      # 让 [ -f ] 早退, 不真的拉起进程
  local rc=0
  ensure_server 1 || rc=$?
  if [ "$rc" -eq 1 ]; then
    ok "ensure_server: 拉不起时返回 1"
  else
    bad "ensure_server: 期望返回 1, 实际 $rc"
  fi
  cleanup
}

run_all() {
  case_spool_disabled
  case_spool_enabled
  case_spool_no_config
  case_drain_pending
  case_drain_empty
  case_ensure_server_down
  echo "SUMMARY pass=$PASS fail=$FAIL"
  [ "$FAIL" -eq 0 ]
}

case "${1:-all}" in
  all)             run_all ;;
  spool_disabled)  case_spool_disabled ;;
  spool_enabled)   case_spool_enabled ;;
  no_config)       case_spool_no_config ;;
  drain_pending)   case_drain_pending ;;
  drain_empty)     case_drain_empty ;;
  ensure_down)     case_ensure_server_down ;;
  *) echo "unknown case: ${1:-}"; exit 2 ;;
esac

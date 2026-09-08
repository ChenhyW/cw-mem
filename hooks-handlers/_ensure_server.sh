#!/usr/bin/env bash
# cw-mem: 确保 server 运行 (lazy-start)
#
# 用法: 调用方先 source _log.sh 与本文件, 再
#   ensure_server [max_wait_seconds]
#     ensure_server 5    # SessionStart: 本 hook 是 session 第一现场, 给足预算
#     ensure_server 3    # PostToolUse: 低预算, 超时即放弃, 由 spool 兜底
#
# 返回: 0 = 已可用; 1 = 未能拉起。调用方负责后续降级(通常是 spool)。
# 前置: SERVER_URL / CW_MEM_DATA_DIR / PLUGIN_ROOT 已由调用方设置。
#
# 先做一次 1s 探活: server 存活时本函数零开销, 只有真的不存活才付出等待成本。

ensure_server() {
  local max="${1:-5}"
  if curl -s --max-time 1 "$SERVER_URL/api/health" > /dev/null 2>&1; then
    return 0
  fi

  local server_js="${SERVER_JS:-$PLUGIN_ROOT/lib/server.js}"
  local data_dir="${CW_MEM_DATA_DIR:-$HOME/.cw-mem}"
  local ui_dir="$PLUGIN_ROOT/ui"
  [ -f "$server_js" ] || return 1
  mkdir -p "$data_dir" 2>/dev/null || true

  log_info "server not running, starting..."

  nohup node "$server_js" "$data_dir" "$ui_dir" > "$data_dir/server.log" 2>&1 &

  local n i
  n=$(( max * 2 ))
  [ "$n" -lt 1 ] && n=1
  for i in $(seq 1 "$n"); do
    if curl -s --max-time 1 "$SERVER_URL/api/health" > /dev/null 2>&1; then
      log_info "server started"
      return 0
    fi
    sleep 0.5
  done
  log_warn "server failed to start within ${max}s"
  return 1
}

export -f ensure_server

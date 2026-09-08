#!/usr/bin/env bash
# cw-mem: hook 连不上 server 时的本地兜底 (spec §12, 覆盖缺陷 6)
#
# 用法: 调用方先 source 本文件, 再
#   1. 在 node 块里, POST 失败时调 remember('<path>', body) 记下待落盘记录
#   2. node 块结束后调  drain_pending_spool "$PENDING_FILE"
#
# 记录形如 {"path":"/api/x","body":{...}} 追加到 $CW_MEM_DATA_DIR/spool/<ts>-<pid>-<rand>.jsonl。
# server 启动时与周期 sweep 负责排空(lib/queue.js 的 drainSpool), 复用端点的同一份
# handleXxx 逻辑, 不产生第二套写入路径。
#
# 只有 queue.spool.enabled=true 时才写; 关闭时失败即丢弃 —— 与历史行为一致,
# 不偷偷改变用户的选择。config 缺失/malformed 同样按"关闭"处理:
# 切不可"出错反而 spool", 那会让用户以为开了兜底却在原地丢失数据。

spool() {
  local sp_path="$1" sp_body="$2"
  [ -n "$sp_path" ] && [ -n "$sp_body" ] || return 0

  local data_dir="${CW_MEM_DATA_DIR:-$HOME/.cw-mem}"
  local cfg="$data_dir/config.json"
  [ -f "$cfg" ] || return 0

  local enabled
  enabled="$(node -e "
try {
  process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).queue?.spool?.enabled === true));
} catch(e) { process.stdout.write('false'); }
" "$cfg" 2>/dev/null)" || enabled="false"
  [ "$enabled" = "true" ] || return 0

  local spool_dir="$data_dir/spool"
  mkdir -p "$spool_dir" 2>/dev/null || return 0
  local f="$spool_dir/$(date +%s%3N)-$$-$RANDOM.jsonl"
  node -e "
try {
  const fs = require('fs');
  const rec = { path: process.argv[1], body: JSON.parse(process.argv[2]) };
  fs.appendFileSync(process.argv[3], JSON.stringify(rec) + '\n', 'utf8');
} catch(e) {}
" "$sp_path" "$sp_body" "$f" 2>/dev/null || return 0
  log_warn "spooled $sp_path (server unreachable, will drain on server start)" 2>/dev/null || true
  return 0
}

# 取出 node 块写下的失败记录并逐条 spool; 文件用后即删。
# 记录格式: "<path>\t<body-json>" —— JSON.stringify 不产生制表符, 分列无歧义。
drain_pending_spool() {
  local f="$1"
  [ -n "$f" ] && [ -s "$f" ] || return 0
  local p b
  while IFS=$'\t' read -r p b; do
    [ -n "$p" ] && spool "$p" "$b"
  done < "$f"
  rm -f "$f"
}

export -f spool drain_pending_spool

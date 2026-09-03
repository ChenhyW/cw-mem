#!/usr/bin/env bash
# cw-mem: shared logging module (bash side)
#
# 用法: source 本文件后调用
#   log_debug "msg"
#   log_info  "msg"
#   log_warn  "msg"
#   log_error "msg"
#   log_cleanup   # 脚本末尾调用, 清理超期日志
#   log_trunc "prompt 文本" # 按 maxPreviewChars 截断 (隐私)
#
# 日志文件: ~/.cw-mem/cw-mem-YYYYMMDD.log (按天滚动)
# 级别阈值: 由 logLevel 控制, 只有 want >= thresh 才写。
#   debug=0 < info=1 < warn=2 < error=3
# 读取优先级: CW_MEM_LOG_LEVEL 环境变量 > ~/.cw-mem/loglevel 文件 > config.json > 默认 info
# 预览隐私: 含 prompt 的日志在 info 级只记前 maxPreviewChars 字。
#
# 前置: 调用方应先设置 CW_MEM_DATA_DIR (例如 ~/.cw-mem)。

CW_MEM_LOG_LEVEL="${CW_MEM_LOG_LEVEL:-}"
LOG_LEVEL_RESOLVED=""   # 已解析的级别 (被重复读取时缓存)
_LOG_CONFIG_LOADED=""

_log_level_num() {
  case "$1" in
    debug) echo 0 ;; info) echo 1 ;; warn) echo 2 ;; error) echo 3 ;; *) echo 1 ;;
  esac
}

_log_date_stamp() {
  date '+%Y-%m-%d %H:%M:%S'
}

_log_today_file() {
  local d
  d=$(date '+%Y%m%d')
  echo "$CW_MEM_DATA_DIR/cw-mem-$d.log"
}

_log_load_config() {
  # 把 config.json 的三项塞进全局变量 _CFG_*
  _CFG_LEVEL="info"; _CFG_RETENTION=3; _CFG_PREVIEW=40
  if [ -f "$CW_MEM_DATA_DIR/config.json" ]; then
    local cfg
    cfg=$(node -e "
try { const c = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
  process.stdout.write((c.log&&c.log.level||'info')+' '+(c.log&&c.log.retentionDays||3)+' '+(c.log&&c.log.maxPreviewChars||40));
} catch(e) { process.stdout.write('info 3 40'); }
" "$CW_MEM_DATA_DIR/config.json" 2>/dev/null) || cfg="info 3 40"
    read -r _CFG_LEVEL _CFG_RETENTION _CFG_PREVIEW <<< "$cfg"
  fi
}

_log_resolve_level() {
  # 返回解析后的级别字符串; 缓存避免重复读
  if [ -z "$LOG_LEVEL_RESOLVED" ]; then
    if [ -n "$CW_MEM_LOG_LEVEL" ]; then
      LOG_LEVEL_RESOLVED="$CW_MEM_LOG_LEVEL"
    elif [ -f "$CW_MEM_DATA_DIR/loglevel" ]; then
      LOG_LEVEL_RESOLVED="$(tr -d '[:space:]' < "$CW_MEM_DATA_DIR/loglevel")"
    else
      _log_load_config
      LOG_LEVEL_RESOLVED="$_CFG_LEVEL"
    fi
    # 兜底非法值
    case "$LOG_LEVEL_RESOLVED" in debug|info|warn|error) ;; *) LOG_LEVEL_RESOLVED="info" ;; esac
  fi
  echo "$LOG_LEVEL_RESOLVED"
}

_log_write() {
  local level="$1"; shift
  local want thresh
  want=$(_log_level_num "$level")
  thresh=$(_log_level_num "$(_log_resolve_level)")
  [ "$want" -ge "$thresh" ] || return 0
  mkdir -p "$CW_MEM_DATA_DIR" 2>/dev/null
  printf '[%s] [%s] %s\n' "$(_log_date_stamp)" "$(echo "$level" | tr '[:lower:]' '[:upper:]')" "$*" >> "$(_log_today_file)" 2>/dev/null
}

log_debug() { _log_write debug "$*"; }
log_info()  { _log_write info "$*"; }
log_warn()  { _log_write warn "$*"; }
log_error() { _log_write error "$*"; }

log_trunc() {
  _log_load_config
  local max="${_CFG_PREVIEW:-40}"
  local s="$1"
  if [ "${#s}" -gt "$max" ]; then
    printf '%s...' "${s:0:$max}"
  else
    printf '%s' "$s"
  fi
}

log_cleanup() {
  _log_load_config
  local ret="${_CFG_RETENTION:-3}"
  [ "$ret" -lt 1 ] && ret=1
  local cutoff
  cutoff=$(date -j -v-$((ret - 1))d '+%Y%m%d' 2>/dev/null) || \
    cutoff=$(date -d "-$((ret - 1)) days" '+%Y%m%d' 2>/dev/null) || return 0
  for f in "$CW_MEM_DATA_DIR"/cw-mem-*.log; do
    [ -e "$f" ] || continue
    local day="${f##*-}"; day="${day%.log}"
    if [[ "$day" < "$cutoff" ]]; then rm -f "$f"; fi
  done
}

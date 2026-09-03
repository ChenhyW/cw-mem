// cw-mem: shared logging module (Node.js side)
// 供内联 `node -e` 通过 require 调用, 与 bash 侧 _log.sh 共用同一份日志文件与滚动规则。
//
// 用法:
//   const log = require('./_log.js');
//   log.debug('msg'); log.info('msg'); log.warn('msg'); log.error('msg');
//   log.trunc('prompt ...');   // 按 maxPreviewChars 截断(隐私)
//   log.cleanup();             // 清理超期日志
//
// 日志文件: ~/.cw-mem/cw-mem-YYYYMMDD.log (按天滚动)
// 级别阈值: debug < info < warn < error, 由 level 控制
// 读取优先级: CW_MEM_LOG_LEVEL 环境变量 > ~/.cw-mem/loglevel 文件 > config.json > 默认 info

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.CW_MEM_DATA_DIR || path.join(process.env.HOME || '', '.cw-mem');

const LEVEL_NUM = { debug: 0, info: 1, warn: 2, error: 3 };

let _cfg = null;
function loadConfig() {
  if (_cfg) return _cfg;
  _cfg = { level: 'info', retentionDays: 3, maxPreviewChars: 40 };
  const fp = path.join(DATA_DIR, 'config.json');
  if (fs.existsSync(fp)) {
    try {
      const c = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (c.log) {
        if (c.log.level) _cfg.level = c.log.level;
        if (c.log.retentionDays != null) _cfg.retentionDays = c.log.retentionDays;
        if (c.log.maxPreviewChars != null) _cfg.maxPreviewChars = c.log.maxPreviewChars;
      }
    } catch (e) { /* keep defaults */ }
  }
  return _cfg;
}

function resolveLevel() {
  if (process.env.CW_MEM_LOG_LEVEL) return process.env.CW_MEM_LOG_LEVEL;
  const fp = path.join(DATA_DIR, 'loglevel');
  if (fs.existsSync(fp)) {
    const v = fs.readFileSync(fp, 'utf8').trim();
    if (v) return v;
  }
  return loadConfig().level;
}

function levelNum(v) {
  return (v && LEVEL_NUM[v]) != null ? LEVEL_NUM[v] : 1;
}

function localDateParts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    Y: d.getFullYear(),
    M: pad(d.getMonth() + 1),
    D: pad(d.getDate()),
    h: pad(d.getHours()),
    m: pad(d.getMinutes()),
    s: pad(d.getSeconds())
  };
}

function dateStamp() {
  const p = localDateParts();
  return `${p.Y}-${p.M}-${p.D} ${p.h}:${p.m}:${p.s}`;
}

function todayFile() {
  const p = localDateParts();
  const day = `${p.Y}${p.M}${p.D}`;
  return path.join(DATA_DIR, `cw-mem-${day}.log`);
}

function write(level, msg) {
  const want = levelNum(level);
  const thresh = levelNum(resolveLevel());
  if (want < thresh) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(todayFile(), `[${dateStamp()}] [${level.toUpperCase()}] ${msg}\n`);
  } catch (e) { /* never fail */ }
}

function trunc(s, max) {
  max = max || loadConfig().maxPreviewChars;
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '...' : s;
}

function cleanup() {
  const ret = Math.max(loadConfig().retentionDays, 1);
  const cutoff = new Date(Date.now() - (ret - 1) * 86400000);
  const localCutoff = `${cutoff.getFullYear()}${String(cutoff.getMonth()+1).padStart(2,'0')}${String(cutoff.getDate()).padStart(2,'0')}`;
  try {
    if (!fs.existsSync(DATA_DIR)) return;
    for (const f of fs.readdirSync(DATA_DIR)) {
      const m = f.match(/^cw-mem-(\d{8})\.log$/);
      if (m && m[1] < localCutoff) fs.unlinkSync(path.join(DATA_DIR, f));
    }
  } catch (e) { /* never fail */ }
}

module.exports = {
  debug: (msg) => write('debug', msg),
  info: (msg) => write('info', msg),
  warn: (msg) => write('warn', msg),
  error: (msg) => write('error', msg),
  trunc,
  cleanup
};

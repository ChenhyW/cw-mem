// lib/db.js — cw-mem SQLite + sqlite-vec 初始化、迁移、连接封装。
//
// 表清单:
//   sessions         会话头(按 project_dir 划分, 用于 SessionStart 召回)
//   prompts          统一表(type ∈ {PROMPT, TOOL});TOOL 记录归属 PROMPT(claude_prompt_id)
//   tool_details     1 对多 附属表(每条 TOOL 行的原始 I/O 快照)
//   session_summaries SessionEnd 一次性会话级摘要
//   seq_counters     全局序号发号器;prompts.seq 与 session_summaries.seq 共用一个计数器
//   memories_meta    向量索引的元数据侧(由 sqlite-vec 用 rowid 反查)
//   memories_vec     vec0 虚拟表(embedding float[embedDim])
//
// 关键不变量: embeddings 写入前 L2 归一化, recall 用 cos = 1 - distance²/2 作为相似度。
//             seq 只增不复用: 卡片被删除后号位留空, 不会重新分配给别的行。

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const { deleteEmbedding } = require('./vector');

// 全空 session 摘要的判定条件(旧版本无输入时会落这类行, 召回时被注入成 "### 过往会话" 下的空白条目)。
// 导出供 server 的只读端点复用同一判定, 避免两处谓词漂移。列名不带表别名, JOIN sessions 时可用。
const EMPTY_SESSION_SUMMARY_WHERE = `
  COALESCE(request,'') = '' AND COALESCE(investigated,'') = '' AND COALESCE(learned,'') = ''
  AND COALESCE(completed,'') = '' AND COALESCE(next_steps,'') = '' AND COALESCE(notes,'') = ''
`;

let _vecWarned = false;

function openDb(dataDir, embedDim) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, 'cw-mem.db');
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // 尝试加载 sqlite-vec 扩展;失败不致命(vec0 写入会抛错, 由调用方处理)。
  try {
    const vec = require('sqlite-vec');
    db.loadExtension(vec.getLoadablePath());
  } catch (e) {
    if (!_vecWarned) {
      _vecWarned = true;
      // eslint-disable-next-line no-console
      console.warn('[cw-mem] sqlite-vec 扩展加载失败: ' + e.message + ' (向量化相关功能将不可用)');
    }
  }

  _migrate(db, embedDim);
  return { db, file: dbFile };
}

function _tableExists(db, name) {
  const r = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return r.c > 0;
}

function _addColumnIfMissing(db, table, col, ddl) {
  if (!_tableExists(db, table)) return;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  }
}

function _migrate(db, embedDim) {
  // sessions
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_dir TEXT,
      started_at TEXT,
      last_seen_at TEXT,
      ended_at TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_dir)`);

  // prompts (unified)
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      claude_prompt_id TEXT,
      project_dir TEXT,
      type TEXT NOT NULL,
      tool_name TEXT,
      tool_use_id TEXT,
      prompt TEXT,
      response TEXT,
      summary TEXT,
      summary_meta TEXT,
      summary_status TEXT DEFAULT '',
      retry_attempts INTEGER NOT NULL DEFAULT 0,
      summary_error TEXT,
      summary_updated_at TEXT,
      injected_context TEXT,
      vector_status TEXT DEFAULT '',
      vector_error TEXT,
      seq INTEGER,
      created_at TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_prompts_session ON prompts(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_prompts_claude_pid ON prompts(claude_prompt_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_prompts_status ON prompts(summary_status)`);

  // 向后兼容: 已存在的旧库缺这些列
  _addColumnIfMissing(db, 'prompts', 'tool_use_id', 'TEXT');
  _addColumnIfMissing(db, 'prompts', 'tool_name', 'TEXT');
  _addColumnIfMissing(db, 'prompts', 'claude_prompt_id', 'TEXT');
  _addColumnIfMissing(db, 'prompts', 'response', 'TEXT');
  _addColumnIfMissing(db, 'prompts', 'summary', 'TEXT');
  _addColumnIfMissing(db, 'prompts', 'summary_meta', 'TEXT');
  _addColumnIfMissing(db, 'prompts', 'summary_status', "TEXT DEFAULT ''");
  _addColumnIfMissing(db, 'prompts', 'retry_attempts', 'INTEGER NOT NULL DEFAULT 0');
  _addColumnIfMissing(db, 'prompts', 'summary_error', 'TEXT');
  _addColumnIfMissing(db, 'prompts', 'summary_updated_at', 'TEXT');
  _addColumnIfMissing(db, 'prompts', 'injected_context', 'TEXT');
  _addColumnIfMissing(db, 'prompts', 'vector_status', "TEXT DEFAULT ''");
  _addColumnIfMissing(db, 'prompts', 'vector_error', 'TEXT');
  _addColumnIfMissing(db, 'prompts', 'tool_target', 'TEXT');
  // 注: 不在迁移里反推历史向量化状态 —— 维度重建会清空 memories_meta, 反推会把待补齐的行误标失败。
  // 历史与新增的向量统一由 server 的 runVectorRetry worker 用当前嵌入模型重算, 状态真实可靠。

  // tool_details (1:N, 每个 TOOL 行可有多个细节事件)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt_id INTEGER NOT NULL,
      tool_use_id TEXT,
      tool_name TEXT,
      duration_ms INTEGER,
      input_json TEXT,
      output_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(prompt_id) REFERENCES prompts(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_details_pid ON tool_details(prompt_id)`);
  _addColumnIfMissing(db, 'tool_details', 'output_json', 'TEXT');
  _addColumnIfMissing(db, 'tool_details', 'tool_use_id', 'TEXT');
  _addColumnIfMissing(db, 'tool_details', 'duration_ms', 'INTEGER');
  _addColumnIfMissing(db, 'tool_details', 'claude_prompt_id', 'TEXT');

  // session_summaries
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      request TEXT,
      investigated TEXT,
      learned TEXT,
      completed TEXT,
      next_steps TEXT,
      notes TEXT,
      seq INTEGER,
      created_at TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_summaries_sid ON session_summaries(session_id)`);

  // 全局序号发号器。prompts(PROMPT/TOOL) 与 session_summaries 共用 'global' 这一个键,
  // 三类卡片(PROMPT 卡 / TOOL 卡 / 会话结束摘要卡)因此共享同一编号空间。
  db.exec(`
    CREATE TABLE IF NOT EXISTS seq_counters (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.prepare(`INSERT OR IGNORE INTO seq_counters(name, value) VALUES('global', 0)`).run();

  _addColumnIfMissing(db, 'prompts', 'seq', 'INTEGER');
  _addColumnIfMissing(db, 'session_summaries', 'seq', 'INTEGER');

  // memories_meta — rowid 与 memories_vec 自动共享
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories_meta (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      ref_id INTEGER NOT NULL,
      project TEXT,
      type TEXT,
      concepts TEXT,
      files_modified TEXT,
      title TEXT,
      subtitle TEXT,
      created_at TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_meta_ref ON memories_meta(entity_type, ref_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_meta_project ON memories_meta(project)`);

  // memories_vec — 维度绑定到 embedDim, 改维需 DROP+重建(对应 spec "needs restart")
  if (!_tableExists(db, 'memories_vec')) {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(embedding float[${embedDim}])`);
  } else {
    // 验证维度一致: sqlite-vec 不暴露显式列, 用一次零向量 MATCH(LIMIT 1 强制执行比对)试探。
    // 不匹配(典型: 更换了嵌入模型)时旧向量对新模型无效, 自动重建 + 清旧向量 + 重置待向量化状态,
    // 历史摘要由 server 的向量补齐 worker 用新模型重算。
    try {
      const probe = Buffer.from(new Float32Array(embedDim).buffer);
      db.prepare('SELECT 1 FROM memories_vec WHERE embedding MATCH ? LIMIT 1').all(probe);
    } catch (e) {
      db.exec('DROP TABLE memories_vec');
      db.exec(`CREATE VIRTUAL TABLE memories_vec USING vec0(embedding float[${embedDim}])`);
      db.prepare('DELETE FROM memories_meta').run();
      db.prepare("UPDATE prompts SET vector_status = '', vector_error = NULL WHERE summary_status = 'success'").run();
      // eslint-disable-next-line no-console
      console.warn('[cw-mem] memories_vec 维度不匹配(' + e.message + '), 已重建为 ' + embedDim + ' 维并清除旧向量, 摘要成功的记录将由向量补齐重算');
    }
  }

  // 清理历史空摘要: 放在 memories_vec 建表之后, 才能一并清掉对应向量。
  // 幂等 —— 每次 openDb 都跑; 新版 runSessionSummary 已加空摘要防护, 新行不会命中。
  const empties = db.prepare('SELECT id FROM session_summaries WHERE ' + EMPTY_SESSION_SUMMARY_WHERE).all();
  for (const e of empties) deleteEmbedding(db, 'session', e.id);
  db.prepare('DELETE FROM session_summaries WHERE ' + EMPTY_SESSION_SUMMARY_WHERE).run();

  _backfillToolTarget(db);
  _backfillSeq(db);
}

// 取下一个全局序号。better-sqlite3 是同步单连接, 连续两次 run 不会并发;
// 进程若恰好在这两条语句之间崩掉, 只留一个空号位 —— 唯一性不受影响。
function nextSeq(db) {
  db.prepare(`INSERT OR IGNORE INTO seq_counters(name, value) VALUES('global', 0)`).run();
  db.prepare(`UPDATE seq_counters SET value = value + 1 WHERE name = 'global'`).run();
  return db.prepare(`SELECT value FROM seq_counters WHERE name = 'global'`).get().value;
}

// 回填历史 TOOL 行的 tool_target(复合键 = tool_name + 空格 + file_path), 供流式聚合分桶。
// 分隔符用空格而非 NUL: SQLite 取 TEXT 是 NUL 终止的, 嵌入 NUL 有被截断的风险;
// 而工具名取自固定工具集(Edit/Write/Bash/... 均不含空格), 空格分隔无歧义。
// 幂等: 只看 tool_target IS NULL 的行, 新行由 server 写入时直接落该列。
function _backfillToolTarget(db) {
  const missing = db.prepare("SELECT id FROM prompts WHERE type = 'TOOL' AND tool_target IS NULL").all();
  if (missing.length === 0) return;
  const getName = db.prepare('SELECT tool_name FROM prompts WHERE id = ?');
  const getDetail = db.prepare('SELECT input_json FROM tool_details WHERE prompt_id = ? ORDER BY id ASC LIMIT 1');
  const upd = db.prepare('UPDATE prompts SET tool_target = ? WHERE id = ?');
  for (const m of missing) {
    const r = getName.get(m.id);
    const td = getDetail.get(m.id);
    let fp = '';
    if (td) {
      try {
        const o = JSON.parse(td.input_json || '{}');
        fp = o.file_path || o.path || '';
      } catch (e) { /* input_json 损坏 → 只留 tool_name */ }
    }
    upd.run((r.tool_name || '') + ' ' + fp, m.id);
  }
}

// 回填历史行的全局序号, 让老卡也有 #N(否则新旧两套编号并存, "全局唯一" 就不成立了)。
// 跨两张表按 (created_at, 表, id) 升序发号, 与写入时的先后顺序一致;
// t 的排序只用于 created_at 同毫秒时的稳定次序, 不参与业务语义。
// 幂等: 只看 seq IS NULL 的行, 新行由写入方直接落该列, 不会被回填覆盖。
function _backfillSeq(db) {
  const missing = db.prepare(`
    SELECT 'p' AS t, id, created_at FROM prompts WHERE seq IS NULL
    UNION ALL
    SELECT 's' AS t, id, created_at FROM session_summaries WHERE seq IS NULL
    ORDER BY created_at ASC, t ASC, id ASC
  `).all();
  db.prepare(`INSERT OR IGNORE INTO seq_counters(name, value) VALUES('global', 0)`).run();
  if (missing.length === 0) return;

  const cur = db.prepare(`SELECT value FROM seq_counters WHERE name = 'global'`).get().value;
  const updP = db.prepare('UPDATE prompts SET seq = ? WHERE id = ?');
  const updS = db.prepare('UPDATE session_summaries SET seq = ? WHERE id = ?');
  // 发号 + 落库 + 推进计数器放进一个事务: 崩在中途时整批回滚, 下次启动重跑, 不会产生重复号
  db.transaction(() => {
    let n = cur;
    for (const r of missing) {
      n++;
      if (r.t === 'p') updP.run(n, r.id); else updS.run(n, r.id);
    }
    db.prepare(`UPDATE seq_counters SET value = ? WHERE name = 'global'`).run(n);
  })();
}

module.exports = { openDb, nextSeq, EMPTY_SESSION_SUMMARY_WHERE };

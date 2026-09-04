// lib/db.js — cw-mem SQLite + sqlite-vec 初始化、迁移、连接封装。
//
// 表清单:
//   sessions         会话头(按 project_dir 划分, 用于 SessionStart 召回)
//   prompts          统一表(type ∈ {PROMPT, TOOL});TOOL 记录归属 PROMPT(claude_prompt_id)
//   tool_details     1 对多 附属表(每条 TOOL 行的原始 I/O 快照)
//   session_summaries SessionEnd 一次性会话级摘要
//   memories_meta    向量索引的元数据侧(由 sqlite-vec 用 rowid 反查)
//   memories_vec     vec0 虚拟表(embedding float[embedDim])
//
// 关键不变量: embeddings 写入前 L2 归一化, recall 用 1/(1+distance) 作为相似度代理。

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

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
      created_at TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_summaries_sid ON session_summaries(session_id)`);

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
}

module.exports = { openDb };

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, nextSeq } = require('../lib/db');

test('openDb creates tables and vec0 virtual table', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-db-'));
  const { db } = openDb(dir, 768);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  ['sessions','prompts','tool_details','session_summaries','memories_vec','memories_meta'].forEach(t => assert.ok(tables.includes(t), 'missing ' + t));
});

test('prompts row has injected_context and summary_meta columns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-db-'));
  const { db } = openDb(dir, 768);
  const cols = db.prepare('PRAGMA table_info(prompts)').all().map(c => c.name);
  assert.ok(cols.includes('injected_context'));
  assert.ok(cols.includes('summary_meta'));
});

test('reopening runs migrations idempotently', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-db-'));
  openDb(dir, 768);
  const { db } = openDb(dir, 768);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM prompts').get().c, 0);
});

test('insert and KNN query on memories_vec', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-db-'));
  const { db } = openDb(dir, 4);
  const v = Buffer.from(new Float32Array([0.1,0.2,0.3,0.4]).buffer);
  // sqlite-vec 怪癖: memories_vec.rowid 必须是字面量整数,不能绑定参数。
  db.exec(`INSERT INTO memories_vec(rowid, embedding) VALUES (1, x'${v.toString('hex')}')`);
  const q = Buffer.from(new Float32Array([0.1,0.2,0.3,0.4]).buffer);
  const rows = db.prepare('SELECT rowid, distance FROM memories_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 1').all(q);
  assert.equal(rows[0].rowid, 1);
});

test('prompts has tool_target column and backfills from tool_details', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-db-'));
  const { db } = openDb(dir, 4);
  // 手造老 TOOL 行(无 tool_target) + tool_details 带 path
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, tool_name, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(1, 's1', 'cp1', '/p', 'TOOL', 'Write', '2026-09-03T00:00:00Z');
  db.prepare("INSERT INTO tool_details(prompt_id, tool_name, input_json, created_at) VALUES (?,?,?,?)")
    .run(1, 'Write', '{"path":"/abs/lib/batch.js"}', '2026-09-03T00:00:00Z');
  // 触发回填: reopen
  db.close();
  const { db: db2 } = openDb(dir, 4);
  assert.equal(db2.prepare("SELECT tool_target FROM prompts WHERE id=1").get().tool_target, 'Write /abs/lib/batch.js');
  // Bash 无 file_path → 兜底只留 tool_name(+ 分隔空格)
  db2.prepare("INSERT INTO prompts(id, session_id, project_dir, type, tool_name, created_at) VALUES (?,?,?,?,?,?)")
    .run(2, 's1', '/p', 'TOOL', 'Bash', '2026-09-03T00:00:01Z');
  db2.prepare("INSERT INTO tool_details(prompt_id, tool_name, input_json, created_at) VALUES (?,?,?,?)")
    .run(2, 'Bash', '{"command":"ls"}', '2026-09-03T00:00:01Z');
  db2.close();
  const { db: db3 } = openDb(dir, 4);
  assert.equal(db3.prepare("SELECT tool_target FROM prompts WHERE id=2").get().tool_target, 'Bash ');
  fs.rmSync(dir, { recursive: true });
});

test('nextSeq is globally unique across prompts and session_summaries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-db-'));
  const { db } = openDb(dir, 4);
  assert.deepEqual([nextSeq(db), nextSeq(db), nextSeq(db)], [1, 2, 3], '发号单调递增');
  // 两类卡片共享一个编号空间: 各自的 autoid 互不影响
  db.prepare("INSERT INTO prompts(id, session_id, type, seq, created_at) VALUES (?,?,?,?,?)")
    .run(1, 's1', 'PROMPT', nextSeq(db), '2026-09-01T00:00:00Z');
  db.prepare("INSERT INTO session_summaries(id, session_id, seq, created_at) VALUES (?,?,?,?)")
    .run(1, 's1', nextSeq(db), '2026-09-01T00:00:01Z');
  const all = db.prepare("SELECT seq FROM prompts WHERE seq IS NOT NULL" +
    " UNION ALL SELECT seq FROM session_summaries WHERE seq IS NOT NULL ORDER BY seq").all().map(r => r.seq);
  assert.deepEqual(all, [4, 5], 'PROMPT 卡与会话摘要卡共用同一序列');
  db.close(); fs.rmSync(dir, { recursive: true });
});

test('reopen backfills seq for historical rows and never collides with new seqs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-db-'));
  const { db } = openDb(dir, 4);
  // 手造 0.2.6 之前的老行: 已落库但 seq 为空
  db.prepare("INSERT INTO prompts(id, session_id, type, created_at) VALUES (?,?,?,?)")
    .run(1, 's1', 'PROMPT', '2026-09-01T00:00:00Z');
  db.prepare("INSERT INTO prompts(id, session_id, type, created_at) VALUES (?,?,?,?)")
    .run(2, 's1', 'TOOL', '2026-09-01T00:00:01Z');
  // request 必须非空: openDb 会先清掉六字段全空的旧摘要, 那种行不会被回填
  db.prepare("INSERT INTO session_summaries(id, session_id, request, created_at) VALUES (?,?,?,?)")
    .run(1, 's1', '做一个会话', '2026-09-01T00:00:02Z');
  db.close();

  const { db: db2 } = openDb(dir, 4);
  const seqs = [
    db2.prepare('SELECT seq FROM prompts WHERE id = 1').get().seq,
    db2.prepare('SELECT seq FROM prompts WHERE id = 2').get().seq,
    db2.prepare('SELECT seq FROM session_summaries WHERE id = 1').get().seq
  ];
  assert.deepEqual(seqs, [1, 2, 3], '跨表按 created_at 升序回填');
  // 回填后计数器已推进, 新写入必须接着 3 —— 否则新卡和老卡撞号
  assert.equal(nextSeq(db2), 4);

  // 幂等: 再开一次不改已有编号, 也不重复发号
  db2.close();
  const { db: db3 } = openDb(dir, 4);
  assert.deepEqual(
    [db3.prepare('SELECT seq FROM prompts WHERE id = 1').get().seq,
     db3.prepare('SELECT seq FROM prompts WHERE id = 2').get().seq,
     db3.prepare('SELECT seq FROM session_summaries WHERE id = 1').get().seq],
    [1, 2, 3], '重开不重编号');
  assert.equal(db3.prepare("SELECT value FROM seq_counters WHERE name='global'").get().value, 4);
  db3.close(); fs.rmSync(dir, { recursive: true });
});

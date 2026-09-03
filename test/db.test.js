const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../lib/db');

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

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../lib/db');
const { sessionStartInjection, userPromptInjection } = require('../lib/recall');
const { storeEmbedding, vecToBuffer } = require('../lib/vector');

test('sessionStartInjection returns recent session summaries for project', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-recall-'));
  const { db } = openDb(dir, 4);
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1','/proj');
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s2','/proj');
  db.prepare("INSERT INTO session_summaries(session_id, request, learned, created_at) VALUES(?,?,?,?)").run('s1','do X','learned X','2026-09-01');
  db.prepare("INSERT INTO session_summaries(session_id, request, learned, created_at) VALUES(?,?,?,?)").run('s2','do Y','learned Y','2026-09-02');
  const text = sessionStartInjection({ db, project:'/proj', count:5 });
  assert.ok(text.indexOf('do Y') < text.indexOf('do X')); // most recent first
});

test('sessionStartInjection empty when no summaries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-recall-'));
  const { db } = openDb(dir, 4);
  assert.equal(sessionStartInjection({ db, project:'/proj', count:5 }), '');
});

test('userPromptInjection respects injectMaxCount and minScore', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-recall-'));
  const { db } = openDb(dir, 4);
  storeEmbedding({ db, entity_type:'result', ref_id:1, project:'p', type:'change', concepts:'[]', files_modified:'[]', text:'t1', embedding:[1,0,0,0] });
  storeEmbedding({ db, entity_type:'result', ref_id:2, project:'p', type:'change', concepts:'[]', files_modified:'[]', text:'t2', embedding:[0.9,0.1,0,0] });
  const fakeEmbed = async () => [[1,0,0,0]];
  const cfg = { ollama:{ url:'http://x', embedModel:'m' }, recall:{ topK:5, minScore:0.0, injectMaxCount:1, injectMaxTokens:800 } };
  const { hits } = await userPromptInjection({ db, embedFn:fakeEmbed, cfg, project:'p', prompt:'q' });
  assert.ok(hits.length <= 1);
  assert.equal(hits[0] && hits[0].ref_id, 1);
});

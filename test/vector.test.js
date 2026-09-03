const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../lib/db');
const { storeEmbedding, knnRecall, hybridFileRecall, vecToBuffer } = require('../lib/vector');

function freshDb(dim=4) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-vec-'));
  return openDb(dir, dim);
}

test('storeEmbedding writes vec + meta and KNN finds it', () => {
  const { db } = freshDb();
  storeEmbedding({ db, entity_type:'result', ref_id:1, project:'p', type:'change', concepts:'[]', files_modified:'[]', text:'x', embedding:[0.1,0.2,0.3,0.4] });
  const rows = knnRecall({ db, queryVec: vecToBuffer([0.1,0.2,0.3,0.4]), topK:5, project:'p' });
  assert.ok(rows.some(r => r.ref_id === 1));
});

test('knnRecall filters by project', () => {
  const { db } = freshDb();
  storeEmbedding({ db, entity_type:'result', ref_id:1, project:'p1', type:'change', concepts:'[]', files_modified:'[]', text:'x', embedding:[0.1,0.2,0.3,0.4] });
  storeEmbedding({ db, entity_type:'result', ref_id:2, project:'p2', type:'change', concepts:'[]', files_modified:'[]', text:'x', embedding:[0.1,0.2,0.3,0.4] });
  const rows = knnRecall({ db, queryVec: vecToBuffer([0.1,0.2,0.3,0.4]), topK:10, project:'p1' });
  assert.ok(rows.every(r => r.project === 'p1'));
});

test('hybridFileRecall ranks by file then vector', () => {
  const { db } = freshDb();
  storeEmbedding({ db, entity_type:'tool', ref_id:10, project:'p', type:'change', concepts:'[]', files_modified:'["server.js"]', text:'a', embedding:[1,0,0,0] });
  storeEmbedding({ db, entity_type:'tool', ref_id:11, project:'p', type:'change', concepts:'[]', files_modified:'["server.js"]', text:'b', embedding:[0,1,0,0] });
  const rows = hybridFileRecall({ db, file:'server.js', queryVec: vecToBuffer([1,0,0,0]), topK:5, project:'p' });
  assert.equal(rows[0].ref_id, 10);
});

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

// 回归: 阈值高于语料实际可达相似度时, text 和 error 都是空 —— 光看这两个字段无法区分
// "没命中"和"阈值设太高"。诊断字段必须把阈值、候选数、最高 sim 报回, UI 才有依据。
test('userPromptInjection returns diagnostics when the threshold is unreachable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-recall-'));
  const { db } = openDb(dir, 4);
  // 与查询向量 [1,0,0,0] 不完全相同, 实测 maxSim ≈ 0.9004(< 1), 阈值 0.91 即可制造不可达场景
  storeEmbedding({ db, entity_type:'result', ref_id:1, project:'p', type:'change', concepts:'[]', files_modified:'[]', text:'t1', embedding:[0.9,0.1,0,0] });
  const fakeEmbed = async () => [[1,0,0,0]];
  const base = { db, embedFn:fakeEmbed, project:'p', prompt:'q', ollama:{ url:'http://x', embedModel:'m' } };

  const strict = await userPromptInjection({ ...base, cfg:{ recall:{ topK:5, minScore:0.91, injectMaxCount:3, injectMaxTokens:800 } } });
  assert.equal(strict.text, '');
  assert.equal(strict.error, undefined);
  assert.equal(strict.hits.length, 0);
  assert.equal(strict.minScore, 0.91);
  assert.equal(strict.candidates, 1, 'KNN 候选数应报回, 否则看不出"召回到了但全被阈值挡掉"');
  assert.ok(typeof strict.maxSim === 'number' && strict.maxSim > 0 && strict.maxSim < strict.minScore,
    'maxSim 应落在 (0, 阈值) 之间: ' + strict.maxSim);

  const loose = await userPromptInjection({ ...base, cfg:{ recall:{ topK:5, minScore:0.89, injectMaxCount:3, injectMaxTokens:800 } } });
  assert.ok(loose.text, '阈值降到可达范围后应产出注入文本');
  assert.ok(loose.hits.length > 0);
  assert.equal(loose.minScore, 0.89);
  assert.ok(loose.maxSim >= loose.minScore);

  const boom = await userPromptInjection({
    ...base, embedFn: async () => { throw new Error('down'); },
    cfg:{ recall:{ minScore:0.7 } }
  });
  assert.equal(boom.error, 'down');
  assert.equal(boom.minScore, 0.7, 'embed 失败时阈值也应报回');
  assert.equal(boom.candidates, 0);
  assert.equal(boom.maxSim, null);
});

// 阈值刻度的真实区间: sqlite-vec 返回 L2 距离(非平方), 归一化向量下 L2 ≤ √2,
// 故 sim = 1/(1+L2) ∈ [1/(1+√2), 1] = [0.4142, 1.0]。默认 0.30 低于下界 → 事实上不过滤。
test('sim scale is bounded by [1/(1+sqrt2), 1] so a threshold below it is a no-op', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-recall-'));
  const { db } = openDb(dir, 2);
  storeEmbedding({ db, entity_type:'result', ref_id:1, project:'p', type:'change', concepts:'[]', files_modified:'[]', text:'a', embedding:[1,0] });
  storeEmbedding({ db, entity_type:'result', ref_id:2, project:'p', type:'change', concepts:'[]', files_modified:'[]', text:'b', embedding:[0,1] });
  const fakeEmbed = async () => [[1,0]];
  const base = { db, embedFn:fakeEmbed, project:'p', prompt:'q', ollama:{ url:'http://x', embedModel:'m' } };

  const all = await userPromptInjection({ ...base, cfg:{ recall:{ topK:5, minScore:0, injectMaxCount:5, injectMaxTokens:800 } } });
  const sims = all.hits.map(h => h.score).sort((a, b) => a - b);
  assert.equal(sims.length, 2);
  assert.ok(Math.abs(sims[0] - 1/(1+Math.SQRT2)) < 1e-6, '正交向量 sim 应等于下界 0.4142, 实际 ' + sims[0]);
  assert.ok(Math.abs(sims[1] - 1) < 1e-6, '相同向量 sim 应等于 1.0, 实际 ' + sims[1]);

  // 默认 0.30 低于下界: 任何候选都过得了, 等于"top-K 全收"
  const atDefault = await userPromptInjection({ ...base, cfg:{ recall:{ topK:5, minScore:0.30, injectMaxCount:5, injectMaxTokens:800 } } });
  assert.equal(atDefault.hits.length, 2, 'minScore=0.30 低于下界, 应全部通过');

  // 0.42 高于下界: 应能真的滤掉正交的那条
  const filtered = await userPromptInjection({ ...base, cfg:{ recall:{ topK:5, minScore:0.42, injectMaxCount:5, injectMaxTokens:800 } } });
  assert.equal(filtered.hits.length, 1, 'minScore=0.42 应滤掉下界候选');
  assert.equal(filtered.hits[0].ref_id, 1);
});

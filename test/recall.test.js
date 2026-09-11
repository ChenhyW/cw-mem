const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../lib/db');
const { sessionStartInjection, userPromptInjection, scoreTest } = require('../lib/recall');
const { storeEmbedding, vecToBuffer, cosineFromDistance } = require('../lib/vector');

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

test('userPromptInjection respects injectMaxCount and minCosine', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-recall-'));
  const { db } = openDb(dir, 4);
  storeEmbedding({ db, entity_type:'result', ref_id:1, project:'p', type:'change', concepts:'[]', files_modified:'[]', text:'t1', embedding:[1,0,0,0] });
  storeEmbedding({ db, entity_type:'result', ref_id:2, project:'p', type:'change', concepts:'[]', files_modified:'[]', text:'t2', embedding:[0.9,0.1,0,0] });
  const fakeEmbed = async () => [[1,0,0,0]];
  const cfg = { ollama:{ url:'http://x', embedModel:'m' }, recall:{ topK:5, minCosine:0, injectMaxCount:1, injectMaxTokens:800 } };
  const { hits } = await userPromptInjection({ db, embedFn:fakeEmbed, cfg, project:'p', prompt:'q' });
  assert.ok(hits.length <= 1);
  assert.equal(hits[0] && hits[0].ref_id, 1);
  assert.ok(Math.abs(hits[0].cosine - 1) < 1e-6, '同向量余弦应为 1: ' + (hits[0] && hits[0].cosine));
});

// 回归: 阈值高于语料实际可达余弦时, text 和 error 都是空 —— 光看这两个字段无法区分
// "没命中"和"阈值设太高"。诊断字段必须把阈值、候选数、最高余弦报回, UI 才有依据。
test('userPromptInjection returns diagnostics when the threshold is unreachable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-recall-'));
  const { db } = openDb(dir, 4);
  // 与查询向量 [1,0,0,0] 夹角 45°, 余弦恒为 0.70711(< 0.72), 正好落在"弱相关"带
  storeEmbedding({ db, entity_type:'result', ref_id:1, project:'p', type:'change', concepts:'[]', files_modified:'[]', text:'t1', embedding:[0.5,0.5,0,0] });
  const fakeEmbed = async () => [[1,0,0,0]];
  const base = { db, embedFn:fakeEmbed, project:'p', prompt:'q', ollama:{ url:'http://x', embedModel:'m' } };

  const strict = await userPromptInjection({ ...base, cfg:{ recall:{ topK:5, minCosine:0.72, injectMaxCount:3, injectMaxTokens:800 } } });
  assert.equal(strict.text, '');
  assert.equal(strict.error, undefined);
  assert.equal(strict.hits.length, 0);
  assert.equal(strict.minCosine, 0.72);
  assert.equal(strict.candidates, 1, 'KNN 候选数应报回, 否则看不出"召回到了但全被阈值挡掉"');
  assert.ok(typeof strict.maxCosine === 'number' && strict.maxCosine > 0 && strict.maxCosine < strict.minCosine,
    'maxCosine 应落在 (0, 阈值) 之间: ' + strict.maxCosine);

  const loose = await userPromptInjection({ ...base, cfg:{ recall:{ topK:5, minCosine:0.70, injectMaxCount:3, injectMaxTokens:800 } } });
  assert.ok(loose.text, '阈值降到可达范围后应产出注入文本');
  assert.ok(loose.hits.length > 0);
  assert.equal(loose.minCosine, 0.70);
  assert.ok(loose.maxCosine >= loose.minCosine);

  const boom = await userPromptInjection({
    ...base, embedFn: async () => { throw new Error('down'); },
    cfg:{ recall:{ minCosine:0.7 } }
  });
  assert.equal(boom.error, 'down');
  assert.equal(boom.minCosine, 0.7, 'embed 失败时阈值也应报回');
  assert.equal(boom.candidates, 0);
  assert.equal(boom.maxCosine, null);
});

// 阈值刻度的真实区间: 归一化向量下 L2 ∈ [0, √2], 故 cos = 1 - L2²/2 ∈ [0, 1];
// 方向相反(极端反义)时 cos = -1。低于 0 的阈值等于不过滤。
test('cosine scale is bounded by [-1, 1] so a threshold below 0 is a no-op', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-recall-'));
  const { db } = openDb(dir, 2);
  storeEmbedding({ db, entity_type:'result', ref_id:1, project:'p', type:'change', concepts:'[]', files_modified:'[]', text:'a', embedding:[1,0] });
  storeEmbedding({ db, entity_type:'result', ref_id:2, project:'p', type:'change', concepts:'[]', files_modified:'[]', text:'b', embedding:[0,1] });
  const fakeEmbed = async () => [[1,0]];
  const base = { db, embedFn:fakeEmbed, project:'p', prompt:'q', ollama:{ url:'http://x', embedModel:'m' } };

  const all = await userPromptInjection({ ...base, cfg:{ recall:{ topK:5, minCosine:0, injectMaxCount:5, injectMaxTokens:800 } } });
  const cosines = all.hits.map(h => h.cosine).sort((a, b) => a - b);
  assert.equal(cosines.length, 2);
  // 容差 1e-6: 向量以 float32 落 memories_vec, KNN 的 distance 精度约 1e-7, 不能按双精度比
  assert.ok(Math.abs(cosines[0] - 0) < 1e-6, '正交向量余弦应为 0, 实际 ' + cosines[0]);
  assert.ok(Math.abs(cosines[1] - 1) < 1e-6, '同向量余弦应为 1, 实际 ' + cosines[1]);

  // 默认 0.5 高于正交的 0 → 只留下同向量那条
  const filtered = await userPromptInjection({ ...base, cfg:{ recall:{ topK:5, minCosine:0.5, injectMaxCount:5, injectMaxTokens:800 } } });
  assert.equal(filtered.hits.length, 1, 'minCosine=0.5 应滤掉正交候选');
  assert.equal(filtered.hits[0].ref_id, 1);

  // 0.01 卡在正交(0)与同向量(1)之间 → 同样只留 1 条, 说明刻度在 [0,1] 上连续可用
  const tight = await userPromptInjection({ ...base, cfg:{ recall:{ topK:5, minCosine:0.01, injectMaxCount:5, injectMaxTokens:800 } } });
  assert.equal(tight.hits.length, 1);

  // 低于 0 的阈值 = 不过滤(归一化向量的余弦不会为负)
  const noOp = await userPromptInjection({ ...base, cfg:{ recall:{ topK:5, minCosine:-0.5, injectMaxCount:5, injectMaxTokens:800 } } });
  assert.equal(noOp.hits.length, 2, 'minCosine=-0.5 低于下界, 应全部通过');
});

// ─── 相似度换算 ───
// cosineFromDistance 是注入阈值、UI 显示、探查端点共用的唯一口径。
// 早期 1/(1+L2) 代理把值域压成 [0.4142, 1], 与常识里的余弦不是一把尺子, 已删除。
test('cosineFromDistance follows cos = 1 - d²/2', () => {
  assert.ok(Math.abs(cosineFromDistance(0) - 1) < 1e-12, '同向量 distance=0 → 余弦 1');
  assert.ok(Math.abs(cosineFromDistance(Math.SQRT2) - 0) < 1e-12, '正交 distance=√2 → 余弦 0');
  assert.ok(Math.abs(cosineFromDistance(2) - -1) < 1e-12, '方向相反 distance=2 → 余弦 -1');
  // 单调性: distance 越大余弦越小
  assert.ok(cosineFromDistance(0.2) > cosineFromDistance(0.8), '余弦随 distance 递减');
  // 换算一致性: 由余弦反推 distance 再换算必须还原
  for (const c of [1, 0.7, 0.5, 0, -1]) {
    const d = Math.sqrt(2 - 2 * c);
    assert.ok(Math.abs(cosineFromDistance(d) - c) < 1e-12, 'cos=' + c + ' 往返不一致');
  }
  // 参考带边界(调参时最常卡的两个数)
  for (const c of [0.7, 0.5]) {
    const d = Math.sqrt(2 - 2 * c);
    assert.ok(Math.abs(cosineFromDistance(d) - c) < 1e-12, '参考带 ' + c + ' 换算偏移');
  }
});

// ─── 注入探查 scoreTest ───
// 用途是挑 recall.minCosine, 所以核心契约是"不套阈值": 阈值设得再高也要把排序返回,
// 只标 pass 让 UI 画出阈值线。如果这里被阈值过滤掉, 就调不了参了。
function probeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-recall-'));
  return openDb(dir, 4).db;
}
function probeEmb(db, ref_id, embedding, opts) {
  return storeEmbedding({
    db, entity_type:'result', ref_id, project:(opts && opts.project) || 'p',
    type:(opts && opts.type) || 'change', concepts:'[]', files_modified:'[]',
    text:'t'+ref_id, embedding
  });
}

test('scoreTest returns raw ranked cosines without applying minCosine', async () => {
  const db = probeDb();
  probeEmb(db, 1, [0.9,0.1,0,0]);        // cos ≈ 0.9939 (高相关)
  probeEmb(db, 2, [0.5,0.5,0,0]);        // cos ≈ 0.7071 (高相关, 恰在 0.7 边界上)
  probeEmb(db, 3, [0.5,0,0.5,0]);        // cos ≈ 0.7071 (与 ref 2 同分, 顺序不敏感)
  probeEmb(db, 4, [0.6,0.8,0,0]);        // cos = 0.6     (弱相关)
  probeEmb(db, 5, [0,1,0,0]);            // cos = 0       (不相关)
  const fakeEmbed = async () => [[1,0,0,0]];
  const cfg = { ollama:{ url:'http://x', embedModel:'m' }, recall:{ minCosine:0.99 } };

  // 阈值 0.99 高于语料可达值(最高 0.9939): 注入路径会 0 命中, 探查路径必须照样返回全部
  const r = await scoreTest({ db, embedFn:fakeEmbed, cfg, project:'p', prompt:'q', count:10 });
  assert.equal(r.error, undefined);
  assert.equal(r.hits.length, 5, '探查不套阈值, 应返回全部候选');
  assert.equal(r.candidates, 5);
  assert.ok(r.hits.every((h, i, a) => i === 0 || a[i - 1].cosine >= h.cosine), '按余弦降序');
  assert.deepEqual(r.hits.map(h => h.pass), [true, false, false, false, false], '0.99 只放过最高那条');
  assert.ok(Math.abs(r.hits[4].cosine - 0) < 1e-6, '正交向量余弦应为 0: ' + r.hits[4].cosine);
  assert.ok(r.hits.every(h => !('score' in h)), '探查响应不应再带 score(余弦是唯一口径)');
  assert.equal(r.minCosine, 0.99, '阈值原样报回, UI 才画得出阈值线');
  assert.ok(r.elapsedMs >= 0);

  // 阈值落在 0.9939 与 0.7071 之间 → 恰好切一刀, 这是调参时最想看到的场景
  const mixed = await scoreTest({ db, embedFn:fakeEmbed, cfg:{ recall:{ minCosine:0.8 } }, project:'p', prompt:'q', count:10 });
  assert.deepEqual(mixed.hits.map(h => h.pass), [true, false, false, false, false], '阈值 0.8 应只放过 ref 1');

  // 默认带: 0.7 及以上算高相关
  const band = await scoreTest({ db, embedFn:fakeEmbed, cfg:{ recall:{ minCosine:0.7 } }, project:'p', prompt:'q', count:10 });
  assert.deepEqual(band.hits.map(h => h.pass), [true, true, true, false, false], '阈值 0.7 应放过前 3 条高相关');
});

test('scoreTest dedups by ref_id and honors count', async () => {
  const db = probeDb();
  // 同一 ref_id 用两个 entity_type 各存一条: 同 entity_type 下 storeEmbedding 会先清旧向量,
  // 换 type 才能在库里并存, 用来模拟"重算向量未清干净"留下的重复行
  storeEmbedding({ db, entity_type:'result', ref_id:7, project:'p', type:'change', concepts:'[]', files_modified:'[]', text:'a', embedding:[1,0,0,0] });
  storeEmbedding({ db, entity_type:'tool',   ref_id:7, project:'p', type:'change', concepts:'[]', files_modified:'[]', text:'b', embedding:[0.999,0.0447,0,0] });
  probeEmb(db, 8, [0.5,0.5,0,0]);
  probeEmb(db, 9, [0.6,0.8,0,0]);
  const fakeEmbed = async () => [[1,0,0,0]];
  const cfg = { recall:{ minCosine:0 } };

  const r = await scoreTest({ db, embedFn:fakeEmbed, cfg, project:'p', prompt:'q', count:10 });
  assert.equal(r.hits.length, 3, '3 个不同 ref_id 各 1 条, ref_id 7 的两条向量应合并成 1 条');
  assert.equal(r.candidates, 4, '去重前候选数应报回');
  assert.equal(r.hits[0].ref_id, 7);
  assert.deepEqual(r.hits.map(h => h.rank), [1, 2, 3], 'rank 从 1 连续编号');

  const one = await scoreTest({ db, embedFn:fakeEmbed, cfg, project:'p', prompt:'q', count:1 });
  assert.equal(one.hits.length, 1);
  assert.equal(one.hits[0].ref_id, 7, 'count=1 时仍是最相似那条');
});

test('scoreTest respects the project filter and excludes skip rows', async () => {
  const db = probeDb();
  probeEmb(db, 1, [1,0,0,0]);
  probeEmb(db, 2, [1,0,0,0], { project:'other' });
  probeEmb(db, 3, [1,0,0,0], { type:'skip' });
  const fakeEmbed = async () => [[1,0,0,0]];
  const cfg = { recall:{ minCosine:0 } };

  const scoped = await scoreTest({ db, embedFn:fakeEmbed, cfg, project:'p', prompt:'q', count:10 });
  assert.deepEqual(scoped.hits.map(h => h.ref_id), [1], '只返回本项目的非 skip 记忆');

  const all = await scoreTest({ db, embedFn:fakeEmbed, cfg, project:'', prompt:'q', count:10 });
  assert.deepEqual(all.hits.map(h => h.ref_id).sort(), [1, 2], '不限项目时跨项目返回, skip 仍排除');
});

test('scoreTest reports errors without throwing and clamps bad count', async () => {
  const db = probeDb();
  const cfg = { ollama:{ url:'http://x', embedModel:'m' }, recall:{ minCosine:0.5 } };
  const base = { db, cfg, project:'p' };

  const empty = await scoreTest({ ...base, embedFn: async () => [[1,0,0,0]], prompt:'   ', count:5 });
  assert.equal(empty.error, 'empty prompt');
  assert.equal(empty.hits.length, 0);
  assert.equal(empty.candidates, 0);
  assert.equal(empty.minCosine, 0.5, 'embed 之前返回也要报回阈值');

  const boom = await scoreTest({ ...base, embedFn: async () => { throw new Error('down'); }, prompt:'q', count:5 });
  assert.equal(boom.error, 'down');
  assert.equal(boom.candidates, 0);

  const none = await scoreTest({ ...base, embedFn: async () => [], prompt:'q', count:5 });
  assert.equal(none.error, 'empty embedding');

  // count 非法值不炸, 且无记忆时不该误报 error
  const clamped = await scoreTest({ ...base, embedFn: async () => [[1,0,0,0]], prompt:'q', count:-5 });
  assert.equal(clamped.error, undefined);
  assert.equal(clamped.hits.length, 0);
  const missing = await scoreTest({ ...base, embedFn: async () => [[1,0,0,0]], prompt:'q' });
  assert.equal(missing.error, undefined);
});

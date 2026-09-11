const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_CONFIG, loadConfig, saveConfig, mergeLlm } = require('../lib/config');

test('DEFAULT_CONFIG has 3 sections and mandatory defaults', () => {
  assert.equal(DEFAULT_CONFIG.server.port, 37889);
  assert.equal(DEFAULT_CONFIG.llm.enabled, false);
  assert.equal(DEFAULT_CONFIG.ollama.embedModel, 'nomic-embed-text');
  assert.equal(DEFAULT_CONFIG.ollama.embedDim, 768);
  assert.equal(DEFAULT_CONFIG.toolSummary.enabled, false);
  assert.equal(DEFAULT_CONFIG.toolSummary.skipMode, 'on');
  assert.equal(DEFAULT_CONFIG.recall.topK, 20);
  // 余弦口径: 0.5 即"弱相关及以上", 与 UI 参考带(≥0.7 高 / 0.5~0.7 弱 / <0.5 不)的下界一致
  assert.equal(DEFAULT_CONFIG.recall.minCosine, 0.5);
  assert.equal(DEFAULT_CONFIG.recall.minScore, undefined, '旧 minScore 键已废弃, 不应留在默认配置里');
});

test('saveConfig then loadConfig round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-cfg-'));
  saveConfig(dir, { ...DEFAULT_CONFIG, server: { port: 39999 } });
  const loaded = loadConfig(dir);
  assert.equal(loaded.server.port, 39999);
  assert.equal(loaded.ollama.embedModel, 'nomic-embed-text');
});

test('mergeLlm keeps base apiKey when input omits it', () => {
  const base = { ...DEFAULT_CONFIG.llm, apiKey: 'sk-real' };
  const out = mergeLlm(base, { enabled: true });
  assert.equal(out.apiKey, 'sk-real');
  assert.equal(out.enabled, true);
});

test('mergeLlm rejects invalid provider', () => {
  const out = mergeLlm({ ...DEFAULT_CONFIG.llm }, { provider: 'gemini' });
  assert.equal(out.provider, 'openai-compatible');
});

test('loadConfig reads queue section with defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-cfg-'));
  const cfg = loadConfig(dir);
  assert.equal(cfg.queue.pollMs, 200);
  assert.equal(cfg.queue.quiescenceSeconds, 30);
  assert.equal(cfg.queue.toolGroupMax, 6);
  assert.equal(cfg.queue.sweepIntervalSeconds, 60);
  assert.equal(cfg.queue.spool.enabled, false);
  assert.equal(cfg.toolSummary.payloadMaxBytes, 524288);
  fs.rmSync(dir, { recursive: true });
});

// 迁移行为: 旧版本 config.json 里是 recall.minScore(1/(1+L2) 口径), 现在改余弦。
// 阈值口径换掉后旧值没有意义(0.5 旧口径 ≈ 0.5 余弦, 但 0.9 旧口径 ≈ 0.994 余弦, 差很远),
// 所以旧键一律忽略、回落默认, 而不是按数值搬过去 —— 搬过去会静默收紧/放松阈值。
// 同时要确认旧键不泄漏到返回的 cfg 里, 否则 UI 会读到过期字段。
test('loadConfig ignores a legacy recall.minScore and falls back to minCosine default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-cfg-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    recall: { topK: 20, minScore: 0.9, injectMaxCount: 3, injectMaxTokens: 800, sessionStartCount: 10 }
  }));
  const cfg = loadConfig(dir);
  assert.equal(cfg.recall.minCosine, DEFAULT_CONFIG.recall.minCosine, '旧 minScore 不换算, 回落默认余弦阈值');
  assert.equal(cfg.recall.minScore, undefined, '旧键不应出现在返回配置里');
  // 同段的其他字段仍然生效, 只有阈值键被换掉
  assert.equal(cfg.recall.topK, 20);
  assert.equal(cfg.recall.injectMaxCount, 3);
  fs.rmSync(dir, { recursive: true });
});

// 运行中保存与磁盘加载必须共用一条校验路径。两条各写一遍范围必然漂移 ——
// 实测发生过: 运行中保存 topK=9999 / minCosine=-1 / injectMaxCount=-3 被照单全收并落盘,
// 要等下次重启被 loadConfig 夹回默认值才暴露, 期间 injectMaxCount=-3 让注入永远 0 命中。
test('applyPartial rejects invalid values and leaves cfg at defaults', () => {
  const { applyPartial } = require('../lib/config');
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  applyPartial(cfg, {
    server: { port: 99999 },
    log: { retentionDays: 9999, maxPreviewChars: 2, level: 'verbose' },
    ollama: { embedDim: 0 },
    toolSummary: { payloadMaxBytes: -1 },
    queue: { pollMs: 5, toolGroupMax: 0, sweepIntervalSeconds: 1 },
    recall: { topK: 9999, minCosine: -1, injectMaxCount: -3, injectMaxTokens: 9 }
  });
  assert.deepEqual(cfg, DEFAULT_CONFIG, '非法值应全部被忽略, cfg 保持默认');

  // 闭区间边界值应当接受
  applyPartial(cfg, { server:{ port:1 }, queue:{ pollMs:50, toolGroupMax:1 }, recall:{ topK:1, minCosine:0, injectMaxTokens:100 } });
  assert.equal(cfg.server.port, 1);
  assert.equal(cfg.queue.pollMs, 50);
  assert.equal(cfg.queue.toolGroupMax, 1);
  assert.equal(cfg.recall.topK, 1);
  assert.equal(cfg.recall.minCosine, 0);
  assert.equal(cfg.recall.injectMaxTokens, 100);

  // NaN/Infinity: typeof 判不出, 但 Number.isFinite 要挡住 —— 落盘后所有 x >= NaN 恒假
  applyPartial(cfg, { recall:{ minCosine: NaN, topK: Infinity, injectMaxCount: -0.0001 } });
  assert.equal(cfg.recall.minCosine, 0);
  assert.equal(cfg.recall.topK, 1);
  assert.equal(cfg.recall.injectMaxCount, DEFAULT_CONFIG.recall.injectMaxCount);
});

test('loadConfig clamps invalid queue values to defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-cfg-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    queue: { pollMs: 5, quiescenceSeconds: 9999, toolGroupMax: 0, sweepIntervalSeconds: 1, spool: { enabled: 'yes' } },
    toolSummary: { payloadMaxBytes: -1 }
  }));
  const cfg = loadConfig(dir);
  assert.equal(cfg.queue.pollMs, 200);            // 5 < 50 → 回落
  assert.equal(cfg.queue.quiescenceSeconds, 30);  // 9999 > 600 → 回落
  assert.equal(cfg.queue.toolGroupMax, 6);        // 0 < 1 → 回落
  assert.equal(cfg.queue.sweepIntervalSeconds, 60);
  assert.equal(cfg.queue.spool.enabled, false);   // 非布尔 → 回落
  assert.equal(cfg.toolSummary.payloadMaxBytes, 524288);
  fs.rmSync(dir, { recursive: true });
});

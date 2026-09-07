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
  assert.equal(DEFAULT_CONFIG.recall.minScore, 0.30);
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

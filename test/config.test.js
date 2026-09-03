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

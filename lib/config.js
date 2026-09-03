// lib/config.js — cw-mem 配置: 默认值、加载、保存、LLM 合并。
//
// 3 个顶层段 (对应 UI 三个分组):
//   server / log             — 基础
//   llm / ollama             — LLM 与向量化
//   toolSummary / recall     — 记忆与召回
//
// `loadConfig(dataDir)`   读 <dataDir>/config.json, 缺字段用 DEFAULT_CONFIG 兜底。
// `saveConfig(dataDir,cfg)` 写 <dataDir>/config.json。
// `mergeLlm(base, input)`  合并 LLM 段: 只在 input 合法时覆盖, 缺字段保留 base。

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CONFIG = {
  server: { port: 37889 },
  log: { level: 'info', retentionDays: 3, maxPreviewChars: 40 },
  llm: {
    enabled: false,
    provider: 'openai-compatible', // openai-compatible | anthropic
    apiBase: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: '',
    maxTokens: 4096,              // 0 = 不限; anthropic 必填故 0 时回落 4096
    reasoningEffort: '',          // 仅 openai-compatible: '' = 不发 / none / low / medium / high
    maxRetries: 3,                // 摘要失败后的最大重试次数; 0 = 不重试
    retryIntervalSeconds: 60,     // 摘要重试定时器扫描间隔(秒)
    timeoutSeconds: 30,           // 单次 LLM 摘要调用超时(秒)
    summaryFieldLimit: 2000       // 摘要模板中单个字段最大字符数, 超限截断(头尾各半保留)
  },
  ollama: {
    url: 'http://127.0.0.1:11434',
    embedModel: 'nomic-embed-text',
    embedDim: 768
  },
  toolSummary: { enabled: false, skipMode: 'on' }, // 工具调用摘要默认关(避免海量工具烧 token)
  recall: {
    topK: 20,                     // KNN 召回候选数
    minScore: 0.30,               // 注入阈值 (1 / (1 + L2^2) 在归一化向量上)
    sessionStartCount: 5,         // SessionStart 注入最近 N 个 session 摘要
    injectMaxCount: 8,            // UserPromptSubmit 注入最多 N 条命中
    injectMaxTokens: 800          // 注入文本最大字符数
  }
};

const VALID_PROVIDERS = new Set(['openai-compatible', 'anthropic']);
const VALID_REASONING = new Set(['', 'none', 'low', 'medium', 'high']);
const VALID_SKIPMODE = new Set(['on', 'off']);

function _intInRange(v, min, max) {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

function loadConfig(dataDir) {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG)); // deep clone
  const file = path.join(dataDir, 'config.json');
  if (!fs.existsSync(file)) return cfg;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return cfg; /* 损坏配置: 兜底返回默认值, 不让单点故障炸服务器 */ }

  if (parsed.server && _intInRange(parsed.server.port, 1, 65535)) {
    cfg.server.port = parsed.server.port;
  }
  if (parsed.log) {
    if (['debug','info','warn','error'].includes(parsed.log.level)) cfg.log.level = parsed.log.level;
    if (_intInRange(parsed.log.retentionDays, 1, 365)) cfg.log.retentionDays = parsed.log.retentionDays;
    if (_intInRange(parsed.log.maxPreviewChars, 10, 10000)) cfg.log.maxPreviewChars = parsed.log.maxPreviewChars;
  }
  if (parsed.llm) {
    cfg.llm = mergeLlm(cfg.llm, parsed.llm);
  }
  if (parsed.ollama) {
    if (typeof parsed.ollama.url === 'string' && parsed.ollama.url) cfg.ollama.url = parsed.ollama.url;
    if (typeof parsed.ollama.embedModel === 'string' && parsed.ollama.embedModel) cfg.ollama.embedModel = parsed.ollama.embedModel;
    if (_intInRange(parsed.ollama.embedDim, 1, 4096)) cfg.ollama.embedDim = parsed.ollama.embedDim;
  }
  if (parsed.toolSummary) {
    if (typeof parsed.toolSummary.enabled === 'boolean') cfg.toolSummary.enabled = parsed.toolSummary.enabled;
    if (VALID_SKIPMODE.has(parsed.toolSummary.skipMode)) cfg.toolSummary.skipMode = parsed.toolSummary.skipMode;
  }
  if (parsed.recall) {
    if (_intInRange(parsed.recall.topK, 1, 1000)) cfg.recall.topK = parsed.recall.topK;
    if (_intInRange(parsed.recall.minScore, 0, 1)) cfg.recall.minScore = parsed.recall.minScore;
    if (_intInRange(parsed.recall.sessionStartCount, 0, 100)) cfg.recall.sessionStartCount = parsed.recall.sessionStartCount;
    if (_intInRange(parsed.recall.injectMaxCount, 0, 100)) cfg.recall.injectMaxCount = parsed.recall.injectMaxCount;
    if (_intInRange(parsed.recall.injectMaxTokens, 100, 100000)) cfg.recall.injectMaxTokens = parsed.recall.injectMaxTokens;
  }
  return cfg;
}

function saveConfig(dataDir, cfg) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
}

// 合并 LLM 配置块: 用 base 兜底再按字段合法性条件覆盖 input;
// 非法/缺字段保留 base, 不让脏值落盘 config.json。
// 注意: toolSummary 在 cw-mem 是顶层段, 不在 llm 里, 故此处不动。
function mergeLlm(base, input) {
  const llm = Object.assign({}, DEFAULT_CONFIG.llm, base);
  if (!input || typeof input !== 'object') return llm;
  if (input.enabled === true || input.enabled === false) llm.enabled = input.enabled;
  if (VALID_PROVIDERS.has(input.provider)) llm.provider = input.provider;
  if (_intInRange(input.maxTokens, 0, 1_000_000)) llm.maxTokens = input.maxTokens;
  if (_intInRange(input.maxRetries, 0, 100)) llm.maxRetries = input.maxRetries;
  if (_intInRange(input.retryIntervalSeconds, 1, 86400)) llm.retryIntervalSeconds = input.retryIntervalSeconds;
  if (_intInRange(input.timeoutSeconds, 1, 3600)) llm.timeoutSeconds = input.timeoutSeconds;
  if (VALID_REASONING.has(input.reasoningEffort)) llm.reasoningEffort = input.reasoningEffort;
  if (_intInRange(input.summaryFieldLimit, 500, 100000)) llm.summaryFieldLimit = input.summaryFieldLimit;
  if (typeof input.apiBase === 'string' && input.apiBase) llm.apiBase = input.apiBase;
  if (typeof input.model === 'string' && input.model) llm.model = input.model;
  if (input.apiKey !== undefined) llm.apiKey = input.apiKey;
  return llm;
}

module.exports = { DEFAULT_CONFIG, loadConfig, saveConfig, mergeLlm };

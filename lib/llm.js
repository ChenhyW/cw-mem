// lib/llm.js — memory-lite LLM 客户端 + 3 套 prompt 模板 + observation 校验。
//
// 模板分三对(kind): tool / result / session,均为"只输出一个合法 JSON"。
// 通用入口 summarize({llm, kind, fields}) 按 kind 选模板、按 provider 拼 payload,
//   再发 HTTP、抽文本。错误一律 reject,由上层 worker 决定退避。
//
// 状态机: pending → generating → success / failed_pending_retry / failed_final。
// maxSummaryAttempts(cfg) = maxRetries + 1(首次 + 重试次数)。

const http = require('node:http');
const https = require('node:https');

// ─── 常量 ─────────────────────────────────────────────────────────
const VALID_OBS_TYPES = ['bugfix','feature','refactor','change','discovery','decision','security','skip'];
const VALID_OBS_CONCEPTS = ['how-it-works','why-it-exists','what-changed','problem-solution','gotcha','pattern','trade-off'];

// ─── 模板 ─────────────────────────────────────────────────────────
// tool 观察:每条工具调用 → 1 条结构化 observation(JSON)
const TOOL_OBSERVATION_TEMPLATE = `[工具] {tool_name}
[输入] {tool_input}
[输出] {tool_output}

请从上述工具调用提炼一条结构化观察(observation)。只输出一个合法 JSON 对象,不要代码块、不要额外说明,字段固定如下:
{{
  "title": "一句话标题,描述系统/项目现在变得不同了什么",
  "action": "调用要完成什么",
  "type": "bugfix|feature|refactor|change|discovery|decision|security|skip 之一",
  "concepts": ["how-it-works|why-it-exists|what-changed|problem-solution|gotcha|pattern|trade-off 等,1-5 个"],
  "filesChanged": ["持久修改的文件路径,无则空数组"],
  "result": "输出/效果",
  "sideEffect": "环境/网络等非文件副作用,无则空字符串"
}}`;

const TOOL_OBSERVATION_SYSTEM = `你是一位工具调用观察助手,负责把每次工具调用提炼成一条可注入长期记忆的结构化观察。

WHAT TO RECORD: 记"系统/项目现在变得不同了什么",而非"正在做什么"。
用动词: implemented / fixed / deployed / configured / migrated / optimized / added / refactored / discovered / confirmed / traced。

GOOD:
- "index.html 添加工具摘要开关并生效,列表按 type 可切换"
- "缓存副本已同步,server.js 重启生效"

BAD(不要这样):
- "分析了实现并保存了发现"
- "执行了 git 命令"

type 选择规则:
- bugfix: 修了一个坏掉的东西
- feature: 新增能力
- refactor: 重构且行为不变
- change: 通用改动(文档/配置/杂项)
- discovery: 了解现有系统
- decision: 有理由的架构/设计选择
- security: 安全相关
- skip: 低信号操作(纯读取/重复状态检查/空输出)。判定为 skip 时仍照写 JSON(保留审计痕迹)。

concepts 选 1-5 个,描述这条观察的知识维度。filesChanged 只列持久修改的真实文件路径,无则空数组。
严格输出合法 JSON;无信息填空字符串或空数组,不要填 "无"。`;

// result 摘要:单轮 prompt+response → 6 字段 JSON
const RESULT_SUMMARY_TEMPLATE = `[用户请求]
{prompt}

[助手回复]
{response}

[相关工具观察(可选)]
{tool_observations}

请提炼本轮的结构化结果摘要。只输出一个合法 JSON 对象,不要代码块、不要额外说明,字段固定如下:
{{
  "request": "用户的请求是什么(一句话)",
  "investigated": "本轮调研/查看了什么,无则空字符串",
  "learned": "本轮学到的关键事实/决定/坑,无则空字符串",
  "completed": "实际完成了什么(动作+产物),无则空字符串",
  "next_steps": "未完成/下一步,无则空字符串",
  "notes": "其他需要记住的上下文(约束/前提),无则空字符串"
}}`;

const RESULT_SUMMARY_SYSTEM = `你是一位记忆提取助手。从用户请求、助手回复与相关工具观察中提炼本轮的结构化摘要。
- 严格按给定 6 字段输出;无则填空字符串,不要填 "无",不要编造,不要复述原文。
- 简洁优先,每字段不超过 200 字。
- 一次返回完整 JSON,不要分步思考。`;

// session 摘要:整段会话 → 6 字段 JSON
const SESSION_SUMMARY_TEMPLATE = `[会话所有轮次摘要]
{result_summaries}

请提炼本次会话的整体结构化摘要。只输出一个合法 JSON 对象,不要代码块、不要额外说明,字段固定如下:
{{
  "request": "用户最初想达成什么",
  "investigated": "整体调研/查看了什么",
  "learned": "整个会话沉淀的关键事实/决定/坑",
  "completed": "会话收尾时实际完成了什么",
  "next_steps": "留给下次的未完成项",
  "notes": "对下次工作有用的上下文(约束/前提/路径)"
}}`;

const SESSION_SUMMARY_SYSTEM = `你是一位会话归档助手。把多轮摘要聚合成一次会话的整体结构化摘要。
- 严格按给定 6 字段输出;无则填空字符串,不要填 "无",不要编造,不要复述原文。
- 简洁优先,每字段不超过 300 字。
- 一次返回完整 JSON,不要分步思考。`;

// ─── 模板选择 ───────────────────────────────────────────────────
const TEMPLATES = {
  tool:    { user: TOOL_OBSERVATION_TEMPLATE,    system: TOOL_OBSERVATION_SYSTEM },
  result:  { user: RESULT_SUMMARY_TEMPLATE,      system: RESULT_SUMMARY_SYSTEM },
  session: { user: SESSION_SUMMARY_TEMPLATE,     system: SESSION_SUMMARY_SYSTEM }
};

function getTemplate(kind) {
  const t = TEMPLATES[kind];
  if (!t) throw new Error('unknown summarize kind: ' + kind);
  return t;
}

// ─── observation 校验 ──────────────────────────────────────────
// 校验并归一化 LLM 输出的 observation JSON;非法时返回 null。
// - type 必须在 VALID_OBS_TYPES;否则默认 'change'
// - concepts 仅保留 VALID_OBS_CONCEPTS,空时默认 ['what-changed']
// - filesChanged 仅保留非空字符串
function validateObservation(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const t = obj.type && VALID_OBS_TYPES.indexOf(obj.type) !== -1 ? obj.type : 'change';
  const c = Array.isArray(obj.concepts)
    ? obj.concepts.filter(x => typeof x === 'string' && VALID_OBS_CONCEPTS.indexOf(x) !== -1).slice(0, 5)
    : [];
  const files = Array.isArray(obj.filesChanged) ? obj.filesChanged.filter(f => typeof f === 'string' && f.length) : [];
  return {
    title:    typeof obj.title      === 'string' ? obj.title.trim()      : '',
    action:   typeof obj.action     === 'string' ? obj.action.trim()     : '',
    type:     t,
    concepts: c.length ? c : ['what-changed'],
    filesChanged: files,
    result:   typeof obj.result     === 'string' ? obj.result.trim()     : '',
    sideEffect: typeof obj.sideEffect === 'string' ? obj.sideEffect.trim() : ''
  };
}

// ─── 通用 summarize ─────────────────────────────────────────────
// summarize({ llm, kind, fields, timeoutSeconds })
//   llm: 加载后的 llm 段({ provider, apiBase, model, apiKey, maxTokens, reasoningEffort, timeoutSeconds })
//   kind: 'tool' | 'result' | 'session'
//   fields: 模板占位符字段,如 { tool_name, tool_input, tool_output } 或 { prompt, response, tool_observations }
// 返回: Promise<string>  LLM 输出的纯文本(期望为 JSON)
function summarize({ llm, kind, fields, timeoutSeconds }) {
  if (!llm || typeof llm !== 'object') return Promise.reject(new Error('llm config required'));
  if (!llm.apiKey) return Promise.reject(new Error('missing llm apiKey'));
  const tpl = getTemplate(kind);
  const userText = Object.keys(fields || {}).reduce(
    (acc, k) => acc.replace(new RegExp('\\{' + k + '\\}', 'g'), String(fields[k] == null ? '' : fields[k])),
    tpl.user
  );
  const isAnthropic = llm.provider === 'anthropic';
  const endpoint = isAnthropic ? '/messages' : '/chat/completions';

  function buildPayload(withReasoning) {
    const p = { model: llm.model };
    if (isAnthropic) {
      p.max_tokens = (typeof llm.maxTokens === 'number' && llm.maxTokens > 0) ? llm.maxTokens : 4096;
      p.system = tpl.system;
      p.messages = [{ role: 'user', content: userText }];
    } else {
      if (typeof llm.maxTokens === 'number' && llm.maxTokens > 0) p.max_tokens = llm.maxTokens;
      p.messages = [{ role: 'system', content: tpl.system }, { role: 'user', content: userText }];
      if (withReasoning && llm.reasoningEffort) p.reasoning_effort = llm.reasoningEffort;
    }
    return p;
  }

  const headers = isAnthropic
    ? { 'x-api-key': llm.apiKey, 'anthropic-version': '2023-06-01' }
    : { 'Authorization': 'Bearer ' + llm.apiKey };

  const base = (llm.apiBase || '').replace(/\/+$/, '');
  function resolveUrl() {
    if (!base) return null;
    if (base.indexOf(endpoint) !== -1) return new URL(base);
    const hasV1 = /\/v1\/?$/i.test(base);
    return new URL(base + (hasV1 ? endpoint : '/v1' + endpoint));
  }

  function doRequest(payload) {
    return new Promise((resolve, reject) => {
      const url = resolveUrl();
      if (!url) return reject(new Error('missing llm apiBase'));
      const body = JSON.stringify(payload);
      const isSecure = url.protocol === 'https:';
      const mod = isSecure ? https : http;
      const opts = {
        hostname: url.hostname,
        port: url.port || (isSecure ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, headers)
      };
      const req = mod.request(opts, (res) => {
        let b = '';
        res.on('data', c => b += c);
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      const sec = (typeof timeoutSeconds === 'number' && timeoutSeconds > 0) ? timeoutSeconds
                : (typeof llm.timeoutSeconds === 'number' && llm.timeoutSeconds > 0) ? llm.timeoutSeconds
                : 30;
      const timer = setTimeout(() => { req.destroy(); reject(new Error('llm timeout')); }, sec * 1000);
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
      req.write(body);
      req.end();
    });
  }

  function extractText(body) {
    const parsed = JSON.parse(body);
    let text = '';
    if (isAnthropic) {
      text = (parsed.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    } else {
      text = (parsed.choices || [{}])[0] && (parsed.choices[0].message || {}).content || '';
    }
    return (text || '').replace(/\r/g, '').trim();
  }

  return (async () => {
    // tool 摘要(显式 userText)不发 reasoning_effort,避免模型不支持时 400
    const withReasoning = !!llm.reasoningEffort && !isAnthropic && kind === 'result';
    let r = await doRequest(buildPayload(withReasoning));
    if (r.status === 400 && withReasoning) {
      r = await doRequest(buildPayload(false));
    }
    if (r.status < 200 || r.status >= 300) {
      return Promise.reject(new Error('llm http ' + r.status + ': ' + (r.body || '').slice(0, 200)));
    }
    let text;
    try { text = extractText(r.body); }
    catch (e) { return Promise.reject(new Error('invalid llm response: ' + (r.body || '').slice(0, 200))); }
    if (!text) return Promise.reject(new Error('llm returned empty content'));
    return text;
  })();
}

// ─── 摘要重试阈值 ───────────────────────────────────────────────
// maxRetries 表示总尝试次数(含首次), 例如 3 = 首次 + 2 次重试。
function maxSummaryAttempts(cfg) {
  const r = (cfg && cfg.llm && typeof cfg.llm.maxRetries === 'number' && cfg.llm.maxRetries >= 0)
    ? cfg.llm.maxRetries : 3;
  return r + 1;
}

function summaryTimeoutSeconds(cfg) {
  const t = cfg && cfg.llm
    && typeof cfg.llm.timeoutSeconds === 'number'
    && cfg.llm.timeoutSeconds > 0
    ? cfg.llm.timeoutSeconds : 30;
  return t;
}

// ─── 摘要状态机更新 ─────────────────────────────────────────────
// extra: { error?, attempts? }  可选写入 summary_error / retry_attempts
// 注: db 句柄由调用方传入,此处不耦合打开方式
function setSummaryStatus(db, rowId, status, extra) {
  extra = extra || {};
  const cols = ['summary_status = ?', 'summary_updated_at = ?'];
  const vals = [status, new Date().toISOString()];
  if (extra.error !== undefined) { cols.push('summary_error = ?'); vals.push(extra.error); }
  if (extra.attempts !== undefined) { cols.push('retry_attempts = ?'); vals.push(extra.attempts); }
  vals.push(rowId);
  db.prepare('UPDATE prompts SET ' + cols.join(', ') + ' WHERE id = ?').run(...vals);
}

module.exports = {
  TOOL_OBSERVATION_TEMPLATE,
  TOOL_OBSERVATION_SYSTEM,
  RESULT_SUMMARY_TEMPLATE,
  RESULT_SUMMARY_SYSTEM,
  SESSION_SUMMARY_TEMPLATE,
  SESSION_SUMMARY_SYSTEM,
  VALID_OBS_TYPES,
  VALID_OBS_CONCEPTS,
  validateObservation,
  summarize,
  maxSummaryAttempts,
  summaryTimeoutSeconds,
  setSummaryStatus
};

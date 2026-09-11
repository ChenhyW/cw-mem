// lib/recall.js — cw-mem 召回 + 注入文本装配。
//
// 两个注入点:
//   sessionStartInjection  SessionStart 时按 project 取最近 N 条 session_summaries(时间倒序)
//   userPromptInjection     UserPromptSubmit 时语义召回(向量 KNN)+ 装配注入文本
//
// 相似度: sqlite-vec 返回 L2 距离(非平方), 写入时已 L2 归一化, 归一化向量下 L2 = √(2-2cos),
// 故 cosine = 1 - d²/2 即标准余弦相似度 —— 阈值(minCosine)与 UI 显示统一用它。
// 参考带: ≥0.7 高相关, 0.5~0.7 弱相关, <0.5 不相关。换算见 lib/vector.js 顶部。
// 注入文本 char-trim 到 injectMaxTokens, 避免上下文爆炸。

const { knnRecall, vecToBuffer, cosineFromDistance } = require('./vector');

function _trimToChars(s, max) {
  if (!s) return '';
  if (s.length <= max) return s;
  const half = Math.floor((max - 20) / 2);
  return s.slice(0, half) + '\n…[省略 ' + (s.length - max) + ' 字]…\n' + s.slice(-half);
}

function _parseJsonArray(s) {
  if (!s) return [];
  try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}

// 会话摘要必须有至少一个非空字段才值得注入 —— 全空行渲染出来就是 "### 过往会话" 下的空白条目
const NONEMPTY_SUMMARY_WHERE = `
  AND (COALESCE(ss.request,'') <> '' OR COALESCE(ss.investigated,'') <> '' OR COALESCE(ss.learned,'') <> ''
    OR COALESCE(ss.completed,'') <> '' OR COALESCE(ss.next_steps,'') <> '' OR COALESCE(ss.notes,'') <> '')
`;

// SessionStart: 按 project 取最近 count 条会话摘要, 时间倒序。
// 文本来源字段: request / learned / next_steps(有则拼)。
function sessionStartInjection({ db, project, count }) {
  const rows = db.prepare(`
    SELECT ss.request, ss.investigated, ss.learned, ss.completed, ss.next_steps, ss.notes, ss.created_at
    FROM session_summaries ss
    JOIN sessions s ON ss.session_id = s.id
    WHERE s.project_dir = ?
    ` + NONEMPTY_SUMMARY_WHERE + `
    ORDER BY ss.created_at DESC
    LIMIT ?
  `).all(project, count);
  if (rows.length === 0) return '';
  const blocks = rows.map((r, i) => {
    const parts = [];
    if (r.request) parts.push('请求: ' + r.request);
    if (r.learned) parts.push('学到: ' + r.learned);
    if (r.next_steps) parts.push('下一步: ' + r.next_steps);
    return '### ' + (i + 1) + '. ' + (r.request || '过往会话') + '\n' + parts.join('\n');
  });
  return '## 过往会话摘要(最近 ' + rows.length + ' 次)\n\n' + blocks.join('\n\n');
}

// UserPromptSubmit: 语义召回 + 装配注入文本。
// embedFn: async ({url, model, input}) => number[][]  (lib/embed.embed 的签名)
// cfg: { ollama:{url, embedModel}, recall:{topK, minCosine, injectMaxCount, injectMaxTokens} }
// 返回 { text, hits, error, minCosine, candidates, maxCosine }
//   hits        供审计/UI 展示, 每条带 cosine
//   minCosine   本次实际生效的注入阈值(配置缺省时是代码兜底值, 不是配置原值)
//   candidates  KNN 返回的候选条数(过滤阈值与 skip 之前)
//   maxCosine   最相似候选的余弦; 无候选时 null
// 后三个是诊断字段: 阈值高于语料实际能达到的相似度时会 0 命中(text 为空且 error 为空),
// UI 光看 text/hits 无法区分"没命中"和"阈值设太高", 这组字段让人一眼看出原因。
async function userPromptInjection({ db, embedFn, cfg, project, prompt }) {
  const ollama = (cfg && cfg.ollama) || {};
  const recall = (cfg && cfg.recall) || {};
  const topK = recall.topK || 20;
  const minCosine = typeof recall.minCosine === 'number' ? recall.minCosine : 0.5;
  const injectMaxCount = typeof recall.injectMaxCount === 'number' ? recall.injectMaxCount : 8;
  const injectMaxTokens = typeof recall.injectMaxTokens === 'number' ? recall.injectMaxTokens : 800;

  const diag = { minCosine: minCosine, candidates: 0, maxCosine: null };

  // 1. 把 prompt 向量化
  let vecs;
  try {
    vecs = await embedFn({ url: ollama.url, model: ollama.embedModel, input: prompt });
  } catch (e) {
    return { text: '', hits: [], error: String(e.message || e), ...diag };
  }
  if (!Array.isArray(vecs) || vecs.length === 0 || !Array.isArray(vecs[0])) {
    return { text: '', hits: [], error: 'empty embedding', ...diag };
  }
  const queryBuf = vecToBuffer(vecs[0]);

  // 2. KNN 召回
  const rows = knnRecall({ db, queryVec: queryBuf, topK, project });
  diag.candidates = rows.length;
  if (rows.length) diag.maxCosine = cosineFromDistance(rows[0].distance);

  // 3. 相似度过滤 + 去重 + 截断
  const seen = new Set();
  const hits = [];
  for (const r of rows) {
    if (seen.has(r.ref_id)) continue;
    seen.add(r.ref_id);
    const cosine = cosineFromDistance(r.distance);
    if (cosine < minCosine) continue;
    if (r.type === 'skip') continue;
    hits.push({
      entity_type: r.entity_type,
      ref_id: r.ref_id,
      title: r.title || '',
      subtitle: r.subtitle || '',
      concepts: _parseJsonArray(r.concepts),
      files_modified: _parseJsonArray(r.files_modified),
      cosine: cosine
    });
    if (hits.length >= injectMaxCount) break;
  }

  if (hits.length === 0) return { text: '', hits: [], ...diag };

  // 4. 装配注入文本
  const blocks = hits.map((h, i) => {
    const lines = [];
    lines.push('### ' + (i + 1) + '. ' + (h.title || '#' + h.ref_id));
    if (h.subtitle) lines.push(h.subtitle);
    if (h.files_modified && h.files_modified.length) {
      lines.push('相关文件: ' + h.files_modified.join(', '));
    }
    return lines.join('\n');
  });
  let text = '## 相关过往工作\n\n' + blocks.join('\n\n');
  text = _trimToChars(text, injectMaxTokens);
  return { text, hits, ...diag };
}

// ─── 注入探查 ───
// 用途: 调 recall.minCosine。userPromptInjection 套了阈值, 看不到"差一点就被注入"的条目,
// 所以探查端点走同一套向量化 + KNN, 但**不过滤阈值**, 只标 pass 让 UI 画出阈值线。
// 只读: 不建 PROMPT 行, 不写 injected_context —— 探查不该污染记录。
// 参考带: cosine ≥0.7 高相关, 0.5~0.7 弱相关, <0.5 不相关。
const PROBE_MAX_K = 50;

async function scoreTest({ db, embedFn, cfg, project, prompt, count }) {
  const t0 = Date.now();
  const recall = (cfg && cfg.recall) || {};
  const minCosine = typeof recall.minCosine === 'number' ? recall.minCosine : 0.5;
  const out = { hits: [], minCosine, candidates: 0, elapsedMs: 0 };
  const done = (error) => { if (error) out.error = error; out.elapsedMs = Date.now() - t0; return out; };

  const q = prompt == null ? '' : String(prompt).trim();
  if (!q) return done('empty prompt');

  const ollama = (cfg && cfg.ollama) || {};
  let vecs;
  try {
    vecs = await embedFn({ url: ollama.url, model: ollama.embedModel, input: q });
  } catch (e) {
    return done(String(e.message || e));
  }
  if (!Array.isArray(vecs) || vecs.length === 0 || !Array.isArray(vecs[0])) return done('empty embedding');

  const n = Math.max(1, Math.min(Math.floor(Number(count)) || 1, PROBE_MAX_K));
  const rows = knnRecall({ db, queryVec: vecToBuffer(vecs[0]), topK: n, project: project || '' });
  out.candidates = rows.length;

  // knnRecall 会对同一 ref_id 返回多个 rowid(重算向量未清干净时), 不去重时"前 3 条"
  // 可能是同一条记忆出现三次 —— 与注入路径的去重行为保持一致
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.ref_id)) continue;
    seen.add(r.ref_id);
    const cosine = cosineFromDistance(r.distance);
    out.hits.push({
      rank: out.hits.length + 1,
      entity_type: r.entity_type,
      ref_id: r.ref_id,
      title: r.title || '',
      subtitle: r.subtitle || '',
      concepts: _parseJsonArray(r.concepts),
      files_modified: _parseJsonArray(r.files_modified),
      cosine: cosine,
      pass: cosine >= minCosine
    });
  }
  return done();
}

module.exports = { sessionStartInjection, userPromptInjection, scoreTest };

// lib/recall.js — cw-mem 召回 + 注入文本装配。
//
// 两个注入点:
//   sessionStartInjection  SessionStart 时按 project 取最近 N 条 session_summaries(时间倒序)
//   userPromptInjection     UserPromptSubmit 时语义召回(向量 KNN)+ 装配注入文本
//
// 相似度: sqlite-vec 返回 L2^2, 写入时已 L2 归一化, 故 sim = 1/(1+distance) 与 cosine 同向单调。
// 注入文本 char-trim 到 injectMaxTokens, 避免上下文爆炸。

const { knnRecall } = require('./vector');
const { vecToBuffer } = require('./vector');

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

// SessionStart: 按 project 取最近 count 条会话摘要, 时间倒序。
// 文本来源字段: request / learned / next_steps(有则拼)。
function sessionStartInjection({ db, project, count }) {
  const rows = db.prepare(`
    SELECT ss.request, ss.investigated, ss.learned, ss.completed, ss.next_steps, ss.notes, ss.created_at
    FROM session_summaries ss
    JOIN sessions s ON ss.session_id = s.id
    WHERE s.project_dir = ?
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
// cfg: { ollama:{url, embedModel}, recall:{topK, minScore, injectMaxCount, injectMaxTokens} }
// 返回 { text, hits }  hits 供审计/UI 展示
async function userPromptInjection({ db, embedFn, cfg, project, prompt }) {
  const ollama = (cfg && cfg.ollama) || {};
  const recall = (cfg && cfg.recall) || {};
  const topK = recall.topK || 20;
  const minScore = typeof recall.minScore === 'number' ? recall.minScore : 0.30;
  const injectMaxCount = typeof recall.injectMaxCount === 'number' ? recall.injectMaxCount : 8;
  const injectMaxTokens = typeof recall.injectMaxTokens === 'number' ? recall.injectMaxTokens : 800;

  // 1. 把 prompt 向量化
  let vecs;
  try {
    vecs = await embedFn({ url: ollama.url, model: ollama.embedModel, input: prompt });
  } catch (e) {
    return { text: '', hits: [], error: String(e.message || e) };
  }
  if (!Array.isArray(vecs) || vecs.length === 0 || !Array.isArray(vecs[0])) {
    return { text: '', hits: [], error: 'empty embedding' };
  }
  const queryBuf = vecToBuffer(vecs[0]);

  // 2. KNN 召回
  const rows = knnRecall({ db, queryVec: queryBuf, topK, project });

  // 3. 相似度过滤 + 去重 + 截断
  const seen = new Set();
  const hits = [];
  for (const r of rows) {
    if (seen.has(r.ref_id)) continue;
    seen.add(r.ref_id);
    const sim = 1 / (1 + (r.distance || 0));
    if (sim < minScore) continue;
    if (r.type === 'skip') continue;
    hits.push({
      entity_type: r.entity_type,
      ref_id: r.ref_id,
      title: r.title || '',
      subtitle: r.subtitle || '',
      concepts: _parseJsonArray(r.concepts),
      files_modified: _parseJsonArray(r.files_modified),
      score: sim
    });
    if (hits.length >= injectMaxCount) break;
  }

  if (hits.length === 0) return { text: '', hits: [] };

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
  return { text, hits };
}

module.exports = { sessionStartInjection, userPromptInjection };

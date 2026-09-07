// lib/batch.js — cw-mem 服务端摘要 + 向量化批量处理。
//
// 入口(均接受注入 deps, 便于测试与未来替换 provider):
//   runToolGroupSummary({ db, cfg, toolRowIds, llmMod, embedFn })
//     一组 TOOL 行(同 tool_target)→ 一条合并 observation, 落首行 summary_meta + 向量化首行,
//     其余行 success 但不落 meta。由 Consumer 的流式聚合调用, 取代旧的内联 tool 阶段。
//     LLM 失败不抛(已落行级状态机), 返回 {status:'failed', retryable}; retryable 以行状态为准。
//   runStopBatch({ db, cfg, promptRowId, llmMod, embedFn })
//     对一条 PROMPT 做 Stop 批量:
//       - 读已落库的 TOOL 摘要(由 runToolGroupSummary 产出)拼进 result 模板
//       - 对 PROMPT 生成 result 摘要 → summary + summary_meta + 向量化
//       - 状态机 pending→generating→success/failed_pending_retry/failed_final
//   runSessionSummary({ db, cfg, sessionId, llmMod, embedFn })
//     聚合该 session 的 PROMPT result 摘要 → session 摘要 → session_summaries + 向量化
//     无输入(result 摘要尚未落库)或 LLM 返回全空 → 返回 skipped 且不落库, 由补齐轮次重跑
//     一个 session 只保留一份摘要(重跑时先清旧行及其向量)
//   findSessionsNeedingSummary(db, limit)
//     待补齐会话: 已 ended、尚无 session 摘要、且已有至少一条 PROMPT result 摘要
//
// llmMod 需暴露: summarize / validateObservation / setSummaryStatus / maxSummaryAttempts
// embedFn 签名: async ({url, model, input}) => number[][]
//
// 闭环: LLM 不可用/失败 → 落 failed 状态, 不丢闭环, 重试定时器后续接管。

const { storeEmbedding, deleteEmbedding } = require('./vector');

// 连续同类工具调用合并上限: 超过则拆成多组, 控制单次 LLM prompt 体积
const MAX_TOOL_GROUP = 6;

function nowIso() { return new Date().toISOString(); }

function _truncate(s, max) {
  if (!s) return '';
  s = typeof s === 'string' ? s : JSON.stringify(s);
  if (s.length <= max) return s;
  const half = Math.max(1, Math.floor((max - 20) / 2));
  return s.slice(0, half) + '\n...[condensed ' + (s.length - max) + ' chars]...\n' + s.slice(-half);
}

// 按 UTF-8 字节计量截断(maxBytes=0 表示不截断), 头尾各半保留, 风格同 _truncate。
// _truncate 按字符(s.length)计量, 中文场景字符数远小于字节数, 不能直接复用。
function _truncateToBytes(s, maxBytes) {
  if (!s) return '';
  s = typeof s === 'string' ? s : JSON.stringify(s);
  if (maxBytes <= 0) return s;
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  const half = Math.max(1, Math.floor((maxBytes - 20) / 2));
  // subarray 截在多字节字符中间时 toString 会丢弃残缺字节, 不会产出替换字符
  const head = buf.subarray(0, half).toString('utf8');
  const tail = buf.subarray(Math.max(half, buf.length - half)).toString('utf8');
  return head + '\n...[condensed ' + (buf.length - maxBytes) + ' bytes]...\n' + tail;
}

function _resultLegacyText(r) {
  return [
    '请求: ' + (r.request || '无'),
    '调研: ' + (r.investigated || '无'),
    '学到: ' + (r.learned || '无'),
    '完成: ' + (r.completed || '无'),
    '下一步: ' + (r.next_steps || '无'),
    '备注: ' + (r.notes || '无')
  ].join('\n');
}

function _toolLegacyText(o) {
  return [
    '工具: ' + (o.title || o.action || '无'),
    '操作: ' + (o.action || '无'),
    '结果: ' + (o.result || '无'),
    '文件: ' + ((o.filesChanged || []).length ? o.filesChanged.join(', ') : '无'),
    '副作用: ' + (o.sideEffect || '无')
  ].join('\n');
}

function _resultEmbedText(r) {
  return [r.request, r.investigated, r.learned, r.completed].filter(Boolean).join(' | ');
}
function _toolEmbedText(o) {
  return [o.title, o.action, o.result].filter(Boolean).join(' | ');
}
function _sessionEmbedText(s) {
  return [s.request, s.learned, s.completed].filter(Boolean).join(' | ');
}

function _parseJsonSafe(text) {
  if (!text) return null;
  // 容错: LLM 偶尔带 ```json 代码块
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

// 向量化状态落库(UI 展示用): success / failed + 失败原因; 与摘要状态独立, 失败不回退摘要
function _setVectorStatus(db, rowId, status, error) {
  db.prepare("UPDATE prompts SET vector_status = ?, vector_error = ? WHERE id = ?").run(status, error, rowId);
}

// 失败处理: 按剩余次数决定 failed_pending_retry / failed_final
function _applyFailure(db, row, error, cfg, llmMod) {
  const maxAttempts = llmMod.maxSummaryAttempts(cfg);
  if (!cfg.llm || !cfg.llm.enabled || !cfg.llm.apiKey) {
    llmMod.setSummaryStatus(db, row.id, 'failed_final', { error: 'LLM 未启用或缺少 API Key' });
    return;
  }
  const attempts = (row.retry_attempts || 0) + 1;
  if (attempts >= maxAttempts) {
    llmMod.setSummaryStatus(db, row.id, 'failed_final', { error: String(error), attempts });
  } else {
    llmMod.setSummaryStatus(db, row.id, 'failed_pending_retry', { error: String(error), attempts });
  }
}

// 取一组 TOOL 行(同 tool_target), 合并提炼为一条 observation: 落首行 summary_meta + 向量化首行,
// 其余行标记 success 但不落 meta(UI 隐藏、不单独向量化)。
// 契约: LLM 失败/输出非法不抛, 而是对组内每行走 _applyFailure(行级状态机已落
// retry_attempts/summary_status)并返回 {status:'failed', retryable} —— retryable 由行状态判定,
// 不重复判断次数, 避免已 failed_final 的行被反复重跑。仅意外异常才抛。
async function runToolGroupSummary({ db, cfg, toolRowIds, llmMod, embedFn }) {
  if (!toolRowIds || toolRowIds.length === 0) return { status: 'success', retryable: false };
  const ph = toolRowIds.map(() => '?').join(',');
  const rows = db.prepare(
    'SELECT id, tool_name, project_dir FROM prompts WHERE id IN (' + ph + ') ORDER BY id ASC'
  ).all(...toolRowIds);
  if (rows.length === 0) return { status: 'success', retryable: false };

  const first = rows[0];
  const fieldLimit = (cfg.llm && cfg.llm.summaryFieldLimit) || 2000;
  const timeoutSec = (cfg.llm && cfg.llm.timeoutSeconds) || 30;
  const project = first.project_dir || '';
  const getDetail = db.prepare(
    'SELECT input_json, output_json FROM tool_details WHERE prompt_id = ? ORDER BY id ASC LIMIT 1');

  for (const r of rows) llmMod.setSummaryStatus(db, r.id, 'generating');
  try {
    const calls = rows.map(r => {
      const td = getDetail.get(r.id) || {};
      return {
        input: _truncate(td.input_json || '', fieldLimit),
        output: _truncate(td.output_json || '', fieldLimit)
      };
    });
    const text = await llmMod.summarize({
      llm: cfg.llm, kind: 'tool_batch',
      fields: { tool_name: first.tool_name || '', count: String(rows.length), calls: JSON.stringify(calls) },
      timeoutSeconds: timeoutSec
    });
    const parsed = _parseJsonSafe(text);
    const obs = parsed ? llmMod.validateObservation(parsed) : null;
    if (!obs) {
      for (const r of rows) _applyFailure(db, r, 'invalid tool batch observation json', cfg, llmMod);
      return { status: 'failed', retryable: _isPendingRetry(db, first.id) };
    }
    db.prepare("UPDATE prompts SET summary_meta = ?, summary = ? WHERE id = ?")
      .run(JSON.stringify(obs), _toolLegacyText(obs), first.id);
    llmMod.setSummaryStatus(db, first.id, 'success', { error: null });
    // 其余行: 标记 success 但不落 meta(UI 渲染过滤掉无 meta 的 TOOL 卡, 也不单独向量化)
    for (let i = 1; i < rows.length; i++) llmMod.setSummaryStatus(db, rows[i].id, 'success', { error: null });
    // 向量化首行; 失败不回退摘要成功状态(摘要已落库), 召回时缺向量自然不命中, 由向量补齐兜底
    try {
      const emb = await embedFn({ url: cfg.ollama.url, model: cfg.ollama.embedModel, input: _toolEmbedText(obs) });
      storeEmbedding({
        db, entity_type: 'tool', ref_id: first.id, project, type: obs.type,
        concepts: JSON.stringify(obs.concepts), files_modified: JSON.stringify(obs.filesChanged || []),
        title: obs.title, subtitle: obs.action, text: _toolEmbedText(obs), embedding: emb[0]
      });
      _setVectorStatus(db, first.id, 'success', null);
    } catch (ve) {
      _setVectorStatus(db, first.id, 'failed', (ve && ve.message) || String(ve));
      // eslint-disable-next-line no-console
      console.warn('[cw-mem] tool#' + first.id + ' 向量化失败(摘要已成功,不回退): ' + (ve && ve.message));
    }
    return { status: 'success', retryable: false };
  } catch (e) {
    for (const r of rows) _applyFailure(db, r, e.message || String(e), cfg, llmMod);
    return { status: 'failed', retryable: _isPendingRetry(db, first.id) };
  }
}

// 行级状态机是"是否还能重试"的唯一事实来源: _applyFailure 已按次数决定终态。
function _isPendingRetry(db, rowId) {
  const st = db.prepare("SELECT summary_status FROM prompts WHERE id = ?").get(rowId);
  return !!(st && st.summary_status === 'failed_pending_retry');
}

async function runStopBatch({ db, cfg, promptRowId, llmMod, embedFn }) {
  const row = db.prepare("SELECT * FROM prompts WHERE id = ? AND type = 'PROMPT'").get(promptRowId);
  if (!row) return { status: 'not_found' };
  if (!row.response) {
    llmMod.setSummaryStatus(db, row.id, 'failed_final', { error: 'no response' });
    return { status: 'no_response' };
  }
  llmMod.setSummaryStatus(db, row.id, 'generating');

  const fieldLimit = (cfg.llm && cfg.llm.summaryFieldLimit) || 2000;
  const timeoutSec = (cfg.llm && cfg.llm.timeoutSeconds) || 30;
  const project = row.project_dir || '';
  let toolObsList = [];

  try {
    // ── 1. tool 观察(可选) ──
    if (cfg.toolSummary && cfg.toolSummary.enabled) {
      const toolRows = db.prepare(
        "SELECT * FROM prompts WHERE claude_prompt_id = ? AND session_id = ? AND type = 'TOOL' ORDER BY id ASC"
      ).all(row.claude_prompt_id, row.session_id);

      // 向量化一条工具观察(摘要已落库后); 失败不回退摘要成功状态
      const vectorizeTool = async (tr, obs) => {
        try {
          const emb = await embedFn({ url: cfg.ollama.url, model: cfg.ollama.embedModel, input: _toolEmbedText(obs) });
          storeEmbedding({
            db, entity_type: 'tool', ref_id: tr.id, project, type: obs.type,
            concepts: JSON.stringify(obs.concepts), files_modified: JSON.stringify(obs.filesChanged || []),
            title: obs.title, subtitle: obs.action, text: _toolEmbedText(obs),
            embedding: emb[0]
          });
          _setVectorStatus(db, tr.id, 'success', null);
        } catch (ve) {
          _setVectorStatus(db, tr.id, 'failed', (ve && ve.message) || String(ve));
          // eslint-disable-next-line no-console
          console.warn('[cw-mem] tool#' + tr.id + ' 向量化失败(摘要已成功,不回退): ' + (ve && ve.message));
        }
      };

      // 单条工具 → 一条 observation
      const summarizeOneTool = async (tr) => {
        llmMod.setSummaryStatus(db, tr.id, 'generating');
        try {
          const td = db.prepare("SELECT * FROM tool_details WHERE prompt_id = ? ORDER BY id ASC LIMIT 1").get(tr.id);
          const toolInput = _truncate(td && td.input_json ? td.input_json : '', fieldLimit);
          const toolOutput = _truncate(td && td.output_json ? td.output_json : '', fieldLimit);
          const text = await llmMod.summarize({
            llm: cfg.llm, kind: 'tool',
            fields: { tool_name: tr.tool_name || '', tool_input: toolInput, tool_output: toolOutput },
            timeoutSeconds: timeoutSec
          });
          const parsed = _parseJsonSafe(text);
          const obs = parsed ? llmMod.validateObservation(parsed) : null;
          if (!obs) { llmMod.setSummaryStatus(db, tr.id, 'failed_final', { error: 'invalid tool observation json' }); return; }
          db.prepare("UPDATE prompts SET summary_meta = ?, summary = ? WHERE id = ?").run(JSON.stringify(obs), _toolLegacyText(obs), tr.id);
          llmMod.setSummaryStatus(db, tr.id, 'success', { error: null });
          toolObsList.push({ title: obs.title || tr.tool_name, type: obs.type, files: obs.filesChanged || [] });
          await vectorizeTool(tr, obs);
        } catch (e) {
          _applyFailure(db, tr, e.message || String(e), cfg, llmMod);
        }
      };

      // 一组连续同类工具 → 一条合并 observation(落首行, 其余行 success 但无 meta → UI 隐藏、不单独向量化)
      const summarizeToolGroup = async (g) => {
        const first = g.rows[0];
        for (const tr of g.rows) llmMod.setSummaryStatus(db, tr.id, 'generating');
        try {
          const calls = g.rows.map(tr => {
            const td = db.prepare("SELECT * FROM tool_details WHERE prompt_id = ? ORDER BY id ASC LIMIT 1").get(tr.id);
            return {
              input: _truncate(td && td.input_json ? td.input_json : '', fieldLimit),
              output: _truncate(td && td.output_json ? td.output_json : '', fieldLimit)
            };
          });
          const text = await llmMod.summarize({
            llm: cfg.llm, kind: 'tool_batch',
            fields: { tool_name: g.tool_name, count: String(g.rows.length), calls: JSON.stringify(calls) },
            timeoutSeconds: timeoutSec
          });
          const parsed = _parseJsonSafe(text);
          const obs = parsed ? llmMod.validateObservation(parsed) : null;
          if (!obs) {
            for (const tr of g.rows) _applyFailure(db, tr, 'invalid tool batch observation json', cfg, llmMod);
            return;
          }
          db.prepare("UPDATE prompts SET summary_meta = ?, summary = ? WHERE id = ?").run(JSON.stringify(obs), _toolLegacyText(obs), first.id);
          llmMod.setSummaryStatus(db, first.id, 'success', { error: null });
          // 其余行: 标记 success 但不落 meta(UI 渲染过滤掉无 meta 的 TOOL 卡, 也不单独向量化)
          for (let i = 1; i < g.rows.length; i++) llmMod.setSummaryStatus(db, g.rows[i].id, 'success', { error: null });
          toolObsList.push({ title: obs.title || g.tool_name, type: obs.type, files: obs.filesChanged || [] });
          await vectorizeTool(first, obs);
        } catch (e) {
          for (const tr of g.rows) _applyFailure(db, tr, e.message || String(e), cfg, llmMod);
        }
      };

      // 已成功的不重做; 连续相同 tool_name 分组(上限 MAX_TOOL_GROUP)合并, 其余逐条
      const pending = toolRows.filter(tr => tr.summary_status !== 'success');
      const groups = [];
      for (const tr of pending) {
        const last = groups[groups.length - 1];
        if (last && last.tool_name === tr.tool_name && last.rows.length < MAX_TOOL_GROUP) last.rows.push(tr);
        else groups.push({ tool_name: tr.tool_name || '', rows: [tr] });
      }
      for (const g of groups) {
        if (g.rows.length > 1) await summarizeToolGroup(g);
        else await summarizeOneTool(g.rows[0]);
      }
    }

    // ── 2. result 摘要(mandatory) ──
    const toolObsText = toolObsList.length
      ? toolObsList.map((o, i) => (i + 1) + '. ' + o.title + (o.files.length ? ' [' + o.files.join(',') + ']' : '')).join('\n')
      : '无';
    const text = await llmMod.summarize({
      llm: cfg.llm, kind: 'result',
      fields: {
        prompt: _truncate(row.prompt || '', fieldLimit),
        response: _truncate(row.response, fieldLimit),
        tool_observations: toolObsText
      },
      timeoutSeconds: timeoutSec
    });
    const parsed = _parseJsonSafe(text);
    if (!parsed) {
      llmMod.setSummaryStatus(db, row.id, 'failed_final', { error: 'invalid result summary json' });
      return { status: 'failed', reason: 'invalid json' };
    }
    db.prepare("UPDATE prompts SET summary = ?, summary_meta = ? WHERE id = ?")
      .run(_resultLegacyText(parsed), JSON.stringify(parsed), row.id);
    llmMod.setSummaryStatus(db, row.id, 'success', { error: null });

    // 向量化 result: 失败不回退摘要成功状态, 召回时缺向量自然不命中
    try {
      const emb = await embedFn({ url: cfg.ollama.url, model: cfg.ollama.embedModel, input: _resultEmbedText(parsed) });
      storeEmbedding({
        db, entity_type: 'result', ref_id: row.id, project, type: 'change',
        concepts: '[]', files_modified: '[]',
        title: parsed.request || '', subtitle: parsed.completed || '',
        text: _resultEmbedText(parsed), embedding: emb[0]
      });
      _setVectorStatus(db, row.id, 'success', null);
    } catch (ve) {
      _setVectorStatus(db, row.id, 'failed', (ve && ve.message) || String(ve));
      // eslint-disable-next-line no-console
      console.warn('[cw-mem] result#' + row.id + ' 向量化失败(摘要已成功,不回退): ' + (ve && ve.message));
    }
    return { status: 'success', toolObs: toolObsList.length };
  } catch (e) {
    _applyFailure(db, row, e.message || String(e), cfg, llmMod);
    return { status: 'failed', error: String(e.message || e) };
  }
}

// session 摘要的 6 个内容字段; 全空即视为无效摘要
const SESSION_FIELDS = ['request', 'investigated', 'learned', 'completed', 'next_steps', 'notes'];

function _sessionContentLen(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 0;
  let n = 0;
  for (const f of SESSION_FIELDS) n += (typeof parsed[f] === 'string' ? parsed[f].trim().length : 0);
  return n;
}

// 一个 session 只保留一份摘要: 先清掉旧行及其向量痕迹, 避免 resume 后多次 SessionEnd 累积出
// 重复/过期摘要(旧的空摘要还会按 created_at 排到最前, 继续污染后续会话的注入)。
function _replaceSessionSummary(db, sessionId) {
  const stale = db.prepare('SELECT id FROM session_summaries WHERE session_id = ?').all(sessionId);
  for (const s of stale) {
    deleteEmbedding(db, 'session', s.id);
    db.prepare('DELETE FROM session_summaries WHERE id = ?').run(s.id);
  }
  return stale.length;
}

async function runSessionSummary({ db, cfg, sessionId, llmMod, embedFn }) {
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
  if (!session) return { status: 'not_found' };

  const fieldLimit = (cfg.llm && cfg.llm.summaryFieldLimit) || 2000;
  const timeoutSec = (cfg.llm && cfg.llm.timeoutSeconds) || 30;
  const project = session.project_dir || '';

  // 聚合该 session 的 PROMPT result 摘要
  const rows = db.prepare(
    "SELECT summary_meta FROM prompts WHERE session_id = ? AND type = 'PROMPT' AND COALESCE(summary_meta,'') <> '' ORDER BY id ASC"
  ).all(sessionId);
  // 无输入时跳过, 不要调 LLM: 模板只给一个 "无", 而 system prompt 要求"无则填空字符串",
  // 模型会照做产出全空 JSON, 落库后又被注入成 "### 过往会话" 下的空白条目。
  // 典型场景: 用户退出时最后一轮 Stop 批量还没跑完, result 摘要尚未落库 —— 交由补齐轮次重跑。
  if (rows.length === 0) return { status: 'skipped', reason: 'no_result_summaries' };
  const resultSummaries = rows.map((r, i) => {
    let m = null; try { m = JSON.parse(r.summary_meta); } catch (e) {}
    return (i + 1) + '. ' + ((m && (m.request || m.completed)) || '过往轮次');
  }).join('\n');

  try {
    const text = await llmMod.summarize({
      llm: cfg.llm, kind: 'session',
      fields: { result_summaries: _truncate(resultSummaries, fieldLimit) },
      timeoutSeconds: timeoutSec
    });
    const parsed = _parseJsonSafe(text);
    if (!parsed) return { status: 'failed', reason: 'invalid json' };
    // 兜底: 即使输入非空, LLM 也可能回一个全空 JSON —— 同样不落库
    if (_sessionContentLen(parsed) === 0) return { status: 'skipped', reason: 'empty_summary' };

    _replaceSessionSummary(db, sessionId);
    const res = db.prepare(`
      INSERT INTO session_summaries (session_id, request, investigated, learned, completed, next_steps, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, parsed.request || '', parsed.investigated || '', parsed.learned || '', parsed.completed || '', parsed.next_steps || '', parsed.notes || '', nowIso());
    const ssId = Number(res.lastInsertRowid);
    db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run(nowIso(), sessionId);

    // 向量化 session; 失败不回退已落库的摘要(与 tool/result 摘要一致的处理)
    let vectorError = null;
    try {
      const emb = await embedFn({ url: cfg.ollama.url, model: cfg.ollama.embedModel, input: _sessionEmbedText(parsed) });
      storeEmbedding({
        db, entity_type: 'session', ref_id: ssId, project, type: 'change',
        concepts: '[]', files_modified: '[]',
        title: parsed.request || '', subtitle: parsed.completed || '',
        text: _sessionEmbedText(parsed), embedding: emb[0]
      });
    } catch (ve) {
      vectorError = (ve && ve.message) || String(ve);
      // eslint-disable-next-line no-console
      console.warn('[cw-mem] session#' + ssId + ' 向量化失败(摘要已落库,不回退): ' + vectorError);
    }
    return { status: 'success', id: ssId, vectorError };
  } catch (e) {
    return { status: 'failed', error: String(e.message || e) };
  }
}

// 待补齐的会话: 已 ended、尚无 session 摘要、且已有至少一条 PROMPT result 摘要可用。
// SessionEnd 时 result 摘要常常还没落库(runSessionSummary 会 skipped), 由 server 的重试轮次周期性补上。
function findSessionsNeedingSummary(db, limit) {
  return db.prepare(`
    SELECT s.id FROM sessions s
    WHERE s.ended_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM session_summaries ss WHERE ss.session_id = s.id)
      AND EXISTS (SELECT 1 FROM prompts p WHERE p.session_id = s.id AND p.type = 'PROMPT' AND COALESCE(p.summary_meta,'') <> '')
    ORDER BY s.ended_at ASC
    LIMIT ?
  `).all(limit || 5).map(r => r.id);
}

// 向量补齐: 重算"摘要成功但向量缺失/失败"的行(历史失败回填、换嵌入模型后的批量重算)。
// 每轮最多 limit 条, 由 server 重试定时器周期调用, ollama 恢复后历史记录自动收敛为已向量化。
async function runVectorRetry({ db, cfg, embedFn, limit }) {
  // 跳过 1 分钟内刚摘要成功的行, 避免与 runStopBatch 的实时向量化竞争重复写向量
  const cutoff = new Date(Date.now() - 60000).toISOString();
  const rows = db.prepare(`
    SELECT id, type, summary_meta, project_dir FROM prompts
    WHERE summary_status = 'success' AND COALESCE(summary_meta,'') <> ''
      AND summary_updated_at IS NOT NULL AND summary_updated_at < ?
      AND (vector_status = '' OR vector_status = 'failed')
    ORDER BY id ASC LIMIT ?
  `).all(cutoff, limit || 20);
  let ok = 0, fail = 0;
  for (const row of rows) {
    let meta = null;
    try { meta = JSON.parse(row.summary_meta); } catch (e) {}
    if (!meta) continue;
    try {
      const isTool = row.type === 'TOOL';
      const text = isTool ? _toolEmbedText(meta) : _resultEmbedText(meta);
      const emb = await embedFn({ url: cfg.ollama.url, model: cfg.ollama.embedModel, input: text });
      storeEmbedding({
        db, entity_type: isTool ? 'tool' : 'result', ref_id: row.id, project: row.project_dir || '',
        type: isTool ? (meta.type || 'change') : 'change',
        concepts: isTool ? JSON.stringify(meta.concepts || []) : '[]',
        files_modified: isTool ? JSON.stringify(meta.filesChanged || []) : '[]',
        title: meta.title || meta.request || '', subtitle: meta.action || meta.completed || '',
        text, embedding: emb[0]
      });
      _setVectorStatus(db, row.id, 'success', null);
      ok++;
    } catch (e) {
      _setVectorStatus(db, row.id, 'failed', (e && e.message) || String(e));
      fail++;
    }
  }
  return { scanned: rows.length, ok, fail };
}

module.exports = { runStopBatch, runSessionSummary, runVectorRetry, findSessionsNeedingSummary, runToolGroupSummary, _truncateToBytes };

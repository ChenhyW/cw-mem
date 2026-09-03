// lib/batch.js — cw-mem 服务端摘要 + 向量化批量处理。
//
// 两个入口(均接受注入 deps, 便于测试与未来替换 provider):
//   runStopBatch({ db, cfg, promptRowId, llmMod, embedFn })
//     对一条 PROMPT 做 Stop 批量:
//       - (若 toolSummary.enabled) 对每条归属 TOOL 行生成 tool 观察 → summary_meta + 向量化
//       - 对 PROMPT 生成 result 摘要 → summary + summary_meta + 向量化
//       - 状态机 pending→generating→success/failed_pending_retry/failed_final
//   runSessionSummary({ db, cfg, sessionId, llmMod, embedFn })
//     聚合该 session 的 PROMPT result 摘要 → session 摘要 → session_summaries + 向量化
//
// llmMod 需暴露: summarize / validateObservation / setSummaryStatus / maxSummaryAttempts
// embedFn 签名: async ({url, model, input}) => number[][]
//
// 闭环: LLM 不可用/失败 → 落 failed 状态, 不丢闭环, 重试定时器后续接管。

const { storeEmbedding } = require('./vector');

function nowIso() { return new Date().toISOString(); }

function _truncate(s, max) {
  if (!s) return '';
  s = typeof s === 'string' ? s : JSON.stringify(s);
  if (s.length <= max) return s;
  const half = Math.floor((max - 20) / 2);
  return s.slice(0, half) + '\n...[condensed ' + (s.length - max) + ' chars]...\n' + s.slice(-half);
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

      for (const tr of toolRows) {
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
          if (!obs) {
            llmMod.setSummaryStatus(db, tr.id, 'failed_final', { error: 'invalid tool observation json' });
            continue;
          }
          db.prepare("UPDATE prompts SET summary_meta = ?, summary = ? WHERE id = ?")
            .run(JSON.stringify(obs), _toolLegacyText(obs), tr.id);
          llmMod.setSummaryStatus(db, tr.id, 'success', { error: null });
          // 向量化(即使 type=skip 也写入, 保留审计; 召回时过滤 skip)
          const emb = await embedFn({ url: cfg.ollama.url, model: cfg.ollama.embedModel, input: _toolEmbedText(obs) });
          storeEmbedding({
            db, entity_type: 'tool', ref_id: tr.id, project, type: obs.type,
            concepts: JSON.stringify(obs.concepts), files_modified: JSON.stringify(obs.filesChanged || []),
            title: obs.title, subtitle: obs.action, text: _toolEmbedText(obs),
            embedding: emb[0]
          });
          toolObsList.push({ title: obs.title || tr.tool_name, type: obs.type, files: obs.filesChanged || [] });
        } catch (e) {
          _applyFailure(db, tr, e.message || String(e), cfg, llmMod);
        }
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

    // 向量化 result
    const emb = await embedFn({ url: cfg.ollama.url, model: cfg.ollama.embedModel, input: _resultEmbedText(parsed) });
    storeEmbedding({
      db, entity_type: 'result', ref_id: row.id, project, type: 'change',
      concepts: '[]', files_modified: '[]',
      title: parsed.request || '', subtitle: parsed.completed || '',
      text: _resultEmbedText(parsed), embedding: emb[0]
    });
    return { status: 'success', toolObs: toolObsList.length };
  } catch (e) {
    _applyFailure(db, row, e.message || String(e), cfg, llmMod);
    return { status: 'failed', error: String(e.message || e) };
  }
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
  const resultSummaries = rows.length
    ? rows.map((r, i) => {
        let m = null; try { m = JSON.parse(r.summary_meta); } catch (e) {}
        return (i + 1) + '. ' + ((m && (m.request || m.completed)) || '过往轮次');
      }).join('\n')
    : '无';

  try {
    const text = await llmMod.summarize({
      llm: cfg.llm, kind: 'session',
      fields: { result_summaries: _truncate(resultSummaries, fieldLimit) },
      timeoutSeconds: timeoutSec
    });
    const parsed = _parseJsonSafe(text);
    if (!parsed) return { status: 'failed', reason: 'invalid json' };
    const res = db.prepare(`
      INSERT INTO session_summaries (session_id, request, investigated, learned, completed, next_steps, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, parsed.request || '', parsed.investigated || '', parsed.learned || '', parsed.completed || '', parsed.next_steps || '', parsed.notes || '', nowIso());
    const ssId = Number(res.lastInsertRowid);
    db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run(nowIso(), sessionId);

    // 向量化 session
    const emb = await embedFn({ url: cfg.ollama.url, model: cfg.ollama.embedModel, input: _sessionEmbedText(parsed) });
    storeEmbedding({
      db, entity_type: 'session', ref_id: ssId, project, type: 'change',
      concepts: '[]', files_modified: '[]',
      title: parsed.request || '', subtitle: parsed.completed || '',
      text: _sessionEmbedText(parsed), embedding: emb[0]
    });
    return { status: 'success', id: ssId };
  } catch (e) {
    return { status: 'failed', error: String(e.message || e) };
  }
}

module.exports = { runStopBatch, runSessionSummary };

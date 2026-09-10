// lib/server.js — cw-mem HTTP 服务器 + 路由 + 静态 UI + lazy-start 入口。
//
// startServer({ dataDir, uiDir, port }) → Promise<{ server, port }>
//   - 用 lib/db 打开数据库(embedDim 取自当前 config)
//   - 用 lib/config 加载配置
//   - http.createServer + try/catch 路由
//   - port=0 时由 OS 分配, 返回实际端口(供 hook lazy-start 与测试使用)
//
// 路由清单见 plan Task 8。
// 摘要调度不在 server 内: 端点只做同步 DB 写, LLM 工作经 lib/queue 的 Consumer 入队,
// 由进程内单消费者按 (tool_name, file_path) 流式聚合后跑摘要; 启动时 drain spool → recover。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig, saveConfig, mergeLlm } = require('./config');
const { openDb, EMPTY_SESSION_SUMMARY_WHERE } = require('./db');
const { embed } = require('./embed');
const { userPromptInjection, sessionStartInjection } = require('./recall');
const llm = require('./llm');
const { _truncateToBytes } = require('./batch');
const { Consumer } = require('./queue');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function nowIso() { return new Date().toISOString(); }

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req, cb) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try { cb(null, body ? JSON.parse(body) : {}); }
    catch (e) { cb(e); }
  });
}

function parsePayload(v) {
  if (v == null) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return v; } }
  return v;
}

function startServer({ dataDir, uiDir, port }) {
  return new Promise((resolve, reject) => {
    const cfg = loadConfig(dataDir);
    const { db } = openDb(dataDir, cfg.ollama.embedDim);
    const state = { db, cfg, dataDir, uiDir, port: null, server: null, consumer: null };

    function reloadCfg() { state.cfg = loadConfig(dataDir); return state.cfg; }

    function count(table) {
      return db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c;
    }

    function embedFn({ url, model, input }) {
      return embed({ url, model, input, timeoutSeconds: state.cfg.llm.timeoutSeconds || 30 });
    }

    // ─── 端点核心逻辑 ───
    // 端点本身和 spool 排空共用同一份函数, 避免两处逻辑分叉。
    // 纯 DB 写保持同步(ack 前已提交); 只有 LLM 工作经 consumer 入队。

    function truncBytes(s, max) {
      if (s == null) return s;
      return max > 0 ? _truncateToBytes(s, max) : s;
    }

    // POST /api/sessions —— 建/刷新 session
    function handleSession(data) {
      const sid = data.sessionId || '';
      const proj = data.projectDir || null;
      if (!sid) return { status: 'skipped' };
      db.prepare('INSERT OR IGNORE INTO sessions (id, project_dir, started_at, last_seen_at) VALUES (?, ?, ?, ?)')
        .run(sid, proj, nowIso(), nowIso());
      if (proj) db.prepare('UPDATE sessions SET project_dir = ?, last_seen_at = ? WHERE id = ?').run(proj, nowIso(), sid);
      return { status: 'ok' };
    }

    // POST /api/prompts —— 建 PROMPT/TOOL 行
    function handlePrompt(data) {
      const type = (data.type && data.type !== 'PROMPT') ? data.type : 'PROMPT';
      const toolName = (type === 'TOOL' && data.toolName) ? data.toolName : null;
      const claudePromptId = data.claudePromptId || null;
      // tool_use_id 供 spool 排空时回退关联 tool_details(见 handleToolDetails)
      const toolUseId = (type === 'TOOL' && data.toolUseId) ? data.toolUseId : null;
      // TOOL 行写复合键 tool_target = tool_name + 空格 + file_path, 供流式聚合分桶; PROMPT 行留 NULL
      const toolTarget = type === 'TOOL' ? (data.toolName || '') + ' ' + (data.filePath || '') : null;
      const result = db.prepare(
        'INSERT INTO prompts (session_id, prompt, type, tool_name, project_dir, claude_prompt_id, tool_use_id, tool_target, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(data.sessionId || 'unknown', data.prompt || '', type, toolName, data.projectDir || null, claudePromptId, toolUseId, toolTarget, nowIso());
      return { status: 'ok', id: result.lastInsertRowid };
    }

    // POST /api/prompts/response —— 写回 PROMPT 行的 response
    function handleResponse(data) {
      const promptId = data.promptId || '';
      const sessionId = data.sessionId || '';
      const response = data.response || '';
      if (!promptId || !response) return { status: 'skipped' };
      const r = db.prepare("UPDATE prompts SET response = ? WHERE claude_prompt_id = ? AND session_id = ? AND type = 'PROMPT'")
        .run(response, promptId, sessionId);
      return { status: 'ok', changes: r.changes };
    }

    // POST /api/prompts/summarize —— 标记 pending 并入队 result 摘要
    function handleSummarize(data) {
      const promptId = data.promptId || '';
      const sessionId = data.sessionId || '';
      if (!promptId) return { status: 'skipped' };
      const row = db.prepare("SELECT * FROM prompts WHERE claude_prompt_id = ? AND session_id = ? AND type = 'PROMPT' AND COALESCE(response,'') <> ''")
        .get(promptId, sessionId);
      if (!row || !row.response) return { status: 'skipped' };
      const s = row.summary_status || '';
      // pending 也在跳过集内: 旧实现在此漏判, 导致 Stop hook 与重试定时器对同一行重复入队
      // (spec 缺陷 1)。队列 Lane FIFO 下重复 item 会串行跑两次 LLM。
      if (s === 'success' || s === 'generating' || s === 'pending') return { status: 'skipped', reason: s };
      if ((row.retry_attempts || 0) >= llm.maxSummaryAttempts(state.cfg)) return { status: 'skipped', reason: 'max_retries_reached' };
      llm.setSummaryStatus(db, row.id, 'pending');
      if (state.consumer) state.consumer.push({ kind: 'result', sessionId, promptRowId: row.id });
      return { status: 'ok', queued: true, id: row.id };
    }

    // POST /api/sessions/summarize —— 标记 session 结束并入队会话摘要
    function handleSessionSummarize(data) {
      const sessionId = data.sessionId || '';
      if (!sessionId) return { status: 'skipped' };
      db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run(nowIso(), sessionId);
      if (state.consumer) state.consumer.push({ kind: 'session', sessionId, attempts: 0 });
      return { status: 'ok', queued: true, sessionId };
    }

    // POST /api/tool-details —— 写工具 I/O(按 payloadMaxBytes 截断)并入队 tool item
    function handleToolDetails(data) {
      // promptId 缺失时回退关联: spool 排空场景下, tool-details 记录是在 server 宕机期间
      // 写的, 拿不到 /api/prompts 返回的自增 id。优先按 tool_use_id 精确匹配,
      // 再退到本 session 最新一条同名 TOOL 行。
      let promptId = data.promptId != null ? data.promptId : null;
      if (promptId == null && data.sessionId) {
        let hit = null;
        if (data.toolUseId) {
          hit = db.prepare("SELECT id FROM prompts WHERE session_id = ? AND tool_use_id = ? ORDER BY id DESC LIMIT 1")
            .get(data.sessionId, data.toolUseId);
        }
        if (!hit && data.toolName) {
          hit = db.prepare("SELECT id FROM prompts WHERE session_id = ? AND type = 'TOOL' AND tool_name = ? ORDER BY id DESC LIMIT 1")
            .get(data.sessionId, data.toolName);
        }
        if (hit) promptId = hit.id;
      }
      if (promptId == null) return { status: 'skipped', reason: 'no matching TOOL row' };

      const inputJson = data.toolInput != null ? JSON.stringify(data.toolInput) : null;
      const outputJson = data.toolOutput != null ? JSON.stringify(data.toolOutput) : null;
      const max = state.cfg.toolSummary.payloadMaxBytes;
      const r = db.prepare(
        'INSERT INTO tool_details (prompt_id, input_json, output_json, tool_use_id, tool_name, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(promptId, truncBytes(inputJson, max), truncBytes(outputJson, max), data.toolUseId || null, data.toolName || null, data.durationMs != null ? String(data.durationMs) : null, nowIso());
      // TOOL 行已在 /api/prompts 落库并写好 tool_target; 这里补入队触发流式聚合
      const row = db.prepare('SELECT tool_target, tool_name, session_id FROM prompts WHERE id = ?').get(promptId);
      if (row && state.consumer) {
        state.consumer.push({
          kind: 'tool',
          sessionId: row.session_id,
          toolRowId: promptId,
          toolTarget: row.tool_target || ((row.tool_name || '') + ' ')
        });
      }
      return { status: 'ok', id: r.lastInsertRowid };
    }

    // spool 排空复用的 handler 表 —— 与端点共用上述函数, 逻辑不分叉
    const SPOOL_HANDLERS = {
      '/api/sessions': handleSession,
      '/api/prompts': handlePrompt,
      '/api/tool-details': handleToolDetails,
      '/api/prompts/response': handleResponse,
      '/api/prompts/summarize': handleSummarize,
      '/api/sessions/summarize': handleSessionSummarize
    };

    const server = http.createServer((req, res) => {
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = url.pathname;
      try {
        // ─── health ───
        if (pathname === '/api/health' && req.method === 'GET') {
          return json(res, { status: 'ok', db: path.join(dataDir, 'cw-mem.db'), prompts: count('prompts'), sessions: count('sessions') });
        }

        // 队列实况: 待处理 item 数 + 打开的聚合组数(排查"摘要迟迟不落库"用)
        if (pathname === '/api/queue' && req.method === 'GET') {
          return json(res, {
            queued: state.consumer ? state.consumer.queueDepth() : 0,
            openGroups: state.consumer ? state.consumer.openGroupCount() : 0
          });
        }

        // ─── config ───
        if (pathname === '/api/config') {
          if (req.method === 'GET') {
            const safe = JSON.parse(JSON.stringify(reloadCfg()));
            if (safe.llm && safe.llm.apiKey) safe.llm.apiKey = '***' + safe.llm.apiKey.slice(-4);
            else if (safe.llm) safe.llm.apiKey = '';
            return json(res, safe);
          }
          if (req.method === 'POST') {
            return readBody(req, (err, data) => {
              if (err) return json(res, { error: err.message }, 400);
              const cfg = reloadCfg();
              if (data.server && typeof data.server.port === 'number') cfg.server.port = data.server.port;
              if (data.log) {
                if (data.log.level) cfg.log.level = data.log.level;
                if (data.log.retentionDays != null) cfg.log.retentionDays = data.log.retentionDays;
                if (data.log.maxPreviewChars != null) cfg.log.maxPreviewChars = data.log.maxPreviewChars;
              }
              if (data.llm) cfg.llm = mergeLlm(cfg.llm, data.llm);
              if (data.ollama) {
                if (typeof data.ollama.url === 'string' && data.ollama.url) cfg.ollama.url = data.ollama.url;
                if (typeof data.ollama.embedModel === 'string' && data.ollama.embedModel) cfg.ollama.embedModel = data.ollama.embedModel;
                if (typeof data.ollama.embedDim === 'number') cfg.ollama.embedDim = data.ollama.embedDim;
              }
              if (data.toolSummary) {
                if (typeof data.toolSummary.enabled === 'boolean') cfg.toolSummary.enabled = data.toolSummary.enabled;
                if (data.toolSummary.skipMode === 'on' || data.toolSummary.skipMode === 'off') cfg.toolSummary.skipMode = data.toolSummary.skipMode;
                if (typeof data.toolSummary.payloadMaxBytes === 'number' && data.toolSummary.payloadMaxBytes >= 0) {
                  cfg.toolSummary.payloadMaxBytes = data.toolSummary.payloadMaxBytes;
                }
              }
              if (data.queue) {
                if (typeof data.queue.pollMs === 'number') cfg.queue.pollMs = data.queue.pollMs;
                if (typeof data.queue.quiescenceSeconds === 'number') cfg.queue.quiescenceSeconds = data.queue.quiescenceSeconds;
                if (typeof data.queue.toolGroupMax === 'number') cfg.queue.toolGroupMax = data.queue.toolGroupMax;
                if (typeof data.queue.sweepIntervalSeconds === 'number') {
                  cfg.queue.sweepIntervalSeconds = data.queue.sweepIntervalSeconds;
                  if (state.consumer) state.consumer.restartSweep(SPOOL_HANDLERS, dataDir);
                }
                if (data.queue.spool && typeof data.queue.spool.enabled === 'boolean') cfg.queue.spool.enabled = data.queue.spool.enabled;
              }
              if (data.recall) {
                if (typeof data.recall.topK === 'number') cfg.recall.topK = data.recall.topK;
                if (typeof data.recall.minScore === 'number') cfg.recall.minScore = data.recall.minScore;
                if (typeof data.recall.sessionStartCount === 'number') cfg.recall.sessionStartCount = data.recall.sessionStartCount;
                if (typeof data.recall.injectMaxCount === 'number') cfg.recall.injectMaxCount = data.recall.injectMaxCount;
                if (typeof data.recall.injectMaxTokens === 'number') cfg.recall.injectMaxTokens = data.recall.injectMaxTokens;
              }
              const needRestart = (data.server && typeof data.server.port === 'number' && data.server.port !== state.cfg.server.port)
                || (data.ollama && (data.ollama.url || data.ollama.embedModel || data.ollama.embedDim));
              saveConfig(dataDir, cfg);
              state.cfg = cfg;
              return json(res, { status: 'ok', config: cfg, needRestart: !!needRestart });
            });
          }
          return json(res, { error: 'method not allowed' }, 405);
        }

        // ─── restart ───
        if (pathname === '/api/restart' && req.method === 'POST') {
          return readBody(req, (err, data) => {
            if (err) return json(res, { error: err.message }, 400);
            const cfg = reloadCfg();
            if (data.server && typeof data.server.port === 'number') cfg.server.port = data.server.port;
            if (data.llm) cfg.llm = mergeLlm(cfg.llm, data.llm);
            saveConfig(dataDir, cfg);
            state.cfg = cfg;
            return json(res, { status: 'ok', config: cfg, restarting: true });
          });
        }

        // ─── sessions ───
        if (pathname === '/api/sessions' && req.method === 'POST') {
          return readBody(req, (err, data) => {
            if (err) return json(res, { error: err.message }, 400);
            return json(res, handleSession(data));
          });
        }
        if (pathname === '/api/sessions' && req.method === 'GET') {
          const rows = db.prepare(`
            SELECT s.*,
              (SELECT COUNT(*) FROM prompts p WHERE p.session_id = s.id) as prompt_count,
              (SELECT p.prompt FROM prompts p WHERE p.session_id = s.id ORDER BY p.created_at DESC LIMIT 1) as last_prompt
            FROM sessions s
            ORDER BY s.started_at DESC
          `).all();
          return json(res, { sessions: rows });
        }

        // 会话级摘要(SessionEnd 由 batch.js 生成): UI「会话摘要」区块的数据源。
        // 此前该表只有写入方和注入方(recall.js), 没有任何只读端点 —— UI 无从展示,
        // 所以库里 11 条摘要在界面上始终看不见。
        if (pathname === '/api/session-summaries' && req.method === 'GET') {
          const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
          const offset = Math.max(parseInt(url.searchParams.get('offset') || '0'), 0);
          const project = url.searchParams.get('project') || '';
          const base = 'FROM session_summaries ss LEFT JOIN sessions s ON ss.session_id = s.id WHERE NOT ('
            + EMPTY_SESSION_SUMMARY_WHERE + ')';
          const params = [], totalParams = [];
          if (project) { params.push(project); totalParams.push(project); }
          const rows = db.prepare(
            'SELECT ss.*, s.project_dir ' + base + (project ? ' AND s.project_dir = ?' : '')
            + ' ORDER BY ss.created_at DESC LIMIT ? OFFSET ?'
          ).all(...params, limit, offset);
          const total = db.prepare(
            'SELECT COUNT(*) as total ' + base + (project ? ' AND s.project_dir = ?' : '')
          ).get(...totalParams).total;
          return json(res, { summaries: rows, total, limit, offset });
        }

        // ─── prompts ───
        if (pathname === '/api/prompts' && req.method === 'POST') {
          return readBody(req, (err, data) => {
            if (err) return json(res, { error: err.message }, 400);
            return json(res, handlePrompt(data));
          });
        }
        if (pathname === '/api/prompts' && req.method === 'GET') {
          const limit = Math.min(parseInt(url.searchParams.get('limit') || '200'), 1000);
          const offset = parseInt(url.searchParams.get('offset') || '0');
          const sessionId = url.searchParams.get('sessionId') || '';
          const projectDir = url.searchParams.get('project') || '';
          const type = url.searchParams.get('type') || '';
          let sql = 'SELECT * FROM prompts WHERE 1=1';
          let totalSql = 'SELECT COUNT(*) as total FROM prompts WHERE 1=1';
          const params = [], totalParams = [];
          if (sessionId) { sql += ' AND session_id = ?'; params.push(sessionId); totalSql += ' AND session_id = ?'; totalParams.push(sessionId); }
          if (projectDir) { sql += ' AND project_dir = ?'; params.push(projectDir); totalSql += ' AND project_dir = ?'; totalParams.push(projectDir); }
          if (type) { sql += ' AND type = ?'; params.push(type); totalSql += ' AND type = ?'; totalParams.push(type); }
          sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
          params.push(limit, offset);
          const rows = db.prepare(sql).all(...params);
          const total = db.prepare(totalSql).get(...totalParams);
          return json(res, { prompts: rows, total: total.total });
        }

        // Stop 钩子: 写回 PROMPT 行的 response
        if (pathname === '/api/prompts/response' && req.method === 'POST') {
          return readBody(req, (err, data) => {
            if (err) return json(res, { error: err.message }, 400);
            return json(res, handleResponse(data));
          });
        }

        // Stop 入队: 标记 pending 并入队 result 摘要(Lane 保证先 flush 本 session 打开的工具组)
        if (pathname === '/api/prompts/summarize' && req.method === 'POST') {
          return readBody(req, (err, data) => {
            if (err) return json(res, { error: err.message }, 400);
            return json(res, handleSummarize(data));
          });
        }

        // 手动重试: 重置次数并入队 result 摘要
        if (pathname === '/api/prompts/summarize-retry' && req.method === 'POST') {
          return readBody(req, (err, data) => {
            if (err) return json(res, { error: err.message }, 400);
            const id = parseInt(data.id, 10);
            if (!id || isNaN(id)) return json(res, { error: 'missing id' }, 400);
            const row = db.prepare("SELECT * FROM prompts WHERE id = ? AND type = 'PROMPT'").get(id);
            if (!row) return json(res, { error: 'not found' }, 404);
            if (!row.response) return json(res, { status: 'skipped', reason: 'no response' });
            if (row.summary_status === 'generating') return json(res, { status: 'skipped', reason: 'generating' });
            db.prepare("UPDATE prompts SET retry_attempts = 0, summary_error = NULL, summary = NULL WHERE id = ?").run(id);
            llm.setSummaryStatus(db, id, 'pending');
            if (state.consumer) state.consumer.push({ kind: 'result', sessionId: row.session_id, promptRowId: id });
            return json(res, { status: 'ok', queued: true, id: id });
          });
        }

        // 手动触发一轮向量补齐(异步执行, 立即返回)
        if (pathname === '/api/vector/retry' && req.method === 'POST') {
          if (state.consumer) state.consumer.vectorSweep();
          return json(res, { status: 'ok', started: true });
        }

        // ─── tool-details ───
        if (pathname === '/api/tool-details' && req.method === 'POST') {
          return readBody(req, (err, data) => {
            if (err) return json(res, { error: err.message }, 400);
            return json(res, handleToolDetails(data));
          });
        }
        if (pathname === '/api/tool-details' && req.method === 'GET') {
          const id = url.searchParams.get('id') || '';
          const rows = db.prepare('SELECT * FROM tool_details WHERE prompt_id = ? ORDER BY id DESC').all(id);
          if (!rows.length) return json(res, { error: 'not found' }, 404);
          const out = rows.map(row => {
            let input = null, output = null;
            try { if (row.input_json) input = JSON.parse(row.input_json); } catch (e) { input = row.input_json; }
            try { if (row.output_json) output = JSON.parse(row.output_json); } catch (e) { output = row.output_json; }
            return { id: row.id, prompt_id: row.prompt_id, input, output, tool_use_id: row.tool_use_id, tool_name: row.tool_name, duration_ms: row.duration_ms, created_at: row.created_at };
          });
          if (out.length === 1) return json(res, out[0]);
          return json(res, { rows: out });
        }

        // ─── recall ───
        // SessionStart 注入: 取最近 N 条会话摘要
        if (pathname === '/api/recall/session' && req.method === 'GET') {
          const project = url.searchParams.get('project') || '';
          const cfg = reloadCfg();
          const text = sessionStartInjection({ db, project, count: cfg.recall.sessionStartCount });
          return json(res, { text });
        }
        // UserPromptSubmit 语义召回 + 装配注入文本, 同时把 injected_context 写回 PROMPT 行
        if (pathname === '/api/recall/semantic' && req.method === 'POST') {
          return readBody(req, (err, data) => {
            if (err) return json(res, { error: err.message }, 400);
            const cfg = reloadCfg();
            const { promptId, rowId, sessionId, project, prompt } = data;
            const result = userPromptInjection({ db, embedFn, cfg, project: project || '', prompt: prompt || '' })
              .then(({ text, hits, error, minScore, candidates, maxSim }) => {
                // 诊断字段一并落库: minScore/candidates/maxSim 让 UI 区分"无命中"与"阈值高于
                // 语料实际可达相似度", 否则 text 为空时看不出召回是否真的在跑。
                const record = { text, hits: hits || [], error: error || null, minScore, candidates, maxSim };
                // rowId(prompts 主键)优先。claude 的 prompt_id 在同一 session 内会重复 ——
                // 实测 <task-notification> 与真实用户 prompt 共用同一个 id, 按 claude_prompt_id
                // 匹配会把一次注入覆盖到多条历史行上, 最早的记录被静默丢弃。
                if (rowId != null && !Number.isNaN(Number(rowId))) {
                  db.prepare("UPDATE prompts SET injected_context = ? WHERE id = ? AND type = 'PROMPT'")
                    .run(JSON.stringify(record), Number(rowId));
                } else if (promptId && sessionId) {
                  db.prepare("UPDATE prompts SET injected_context = ? WHERE claude_prompt_id = ? AND session_id = ? AND type = 'PROMPT'")
                    .run(JSON.stringify(record), promptId, sessionId);
                }
                return json(res, record);
              })
              .catch(e => json(res, { text: '', hits: [], error: String(e.message || e), minScore: cfg.recall.minScore, candidates: 0, maxSim: null }, 200));
            return result;
          });
        }

        // SessionEnd 触发会话级摘要: 先 flush 本 session 打开的工具组, 再聚合 result 摘要
        if (pathname === '/api/sessions/summarize' && req.method === 'POST') {
          return readBody(req, (err, data) => {
            if (err) return json(res, { error: err.message }, 400);
            return json(res, handleSessionSummarize(data));
          });
        }

        // ─── memories (审计/浏览) ───
        if (pathname === '/api/memories' && req.method === 'GET') {
          const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);
          const offset = Math.max(parseInt(url.searchParams.get('offset') || '0'), 0);
          // 参数绑定 skip 排除(不要双引号包裹, 否则变成字符串字面量过滤的 bug)
          const rows = db.prepare(`
            SELECT m.rowid, m.entity_type, m.ref_id, m.project, m.type, m.concepts, m.files_modified, m.title, m.subtitle, m.created_at
            FROM memories_meta m
            WHERE m.type IS NOT NULL AND m.type <> ?
            ORDER BY m.created_at DESC
            LIMIT ? OFFSET ?
          `).all('skip', limit, offset);
          const total = db.prepare("SELECT COUNT(*) as c FROM memories_meta WHERE type IS NOT NULL AND type <> ?").get('skip').c;
          const out = rows.map(r => ({
            rowid: r.rowid, entity_type: r.entity_type, ref_id: r.ref_id, project: r.project,
            type: r.type, title: r.title, subtitle: r.subtitle,
            concepts: (() => { try { return JSON.parse(r.concepts || '[]'); } catch (e) { return []; } })(),
            files_modified: (() => { try { return JSON.parse(r.files_modified || '[]'); } catch (e) { return []; } })(),
            created_at: r.created_at
          }));
          return json(res, { memories: out, total, limit, offset });
        }

        // ─── projects ───
        if (pathname === '/api/projects' && req.method === 'GET') {
          const rows = db.prepare(
            `SELECT project_dir, COUNT(*) as prompt_count FROM prompts WHERE project_dir IS NOT NULL AND project_dir != '' GROUP BY project_dir ORDER BY prompt_count DESC`
          ).all();
          return json(res, { projects: rows });
        }

        // ─── stats ───
        if (pathname === '/api/stats' && req.method === 'GET') {
          return json(res, {
            totalPrompts: count('prompts'),
            totalSessions: count('sessions'),
            totalMemories: count('memories_meta'),
            todayPrompts: db.prepare("SELECT COUNT(*) as c FROM prompts WHERE date(created_at) = date('now')").get().c,
            topProjects: db.prepare('SELECT project_dir, COUNT(*) as c FROM prompts WHERE project_dir IS NOT NULL GROUP BY project_dir ORDER BY c DESC LIMIT 10').all()
          });
        }

        // ─── 单条 prompt ───
        if (pathname.startsWith('/api/prompts/') && req.method === 'GET') {
          const id = pathname.split('/').pop();
          const row = db.prepare('SELECT * FROM prompts WHERE id = ?').get(id);
          if (!row) return json(res, { error: 'not found' }, 404);
          return json(res, row);
        }

        // ─── 静态 UI ───
        const filePath = pathname === '/' ? path.join(uiDir, 'index.html') : path.join(uiDir, pathname);
        if (uiDir && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(filePath);
          res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
          res.end(fs.readFileSync(filePath));
          return;
        }
        return json(res, { error: 'not found' }, 404);
      } catch (e) {
        return json(res, { error: e.message }, 500);
      }
    });

    state.server = server;
    state.port = port;
    const onError = (e) => reject(e);
    server.once('error', onError);

    // 关闭收尾: 停消费 + best effort flush 打开的组, 然后关 DB。
    // 已丢弃的组由下次启动的 recover() 重建, 不丢数据; 这里是省一轮延迟的优化。
    function shutdown() {
      if (state.consumer) {
        state.consumer.stop();
        return state.consumer.flushAll().finally(closeDb);
      }
      closeDb();
      return Promise.resolve();
    }
    function closeDb() { try { db.close(); } catch (e) { /* 已关闭 */ } }

    server.on('close', shutdown);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      state.port = server.address().port;
      // 启动序列: 排空本地 spool → 从 DB 重建待办 → 启动消费 + 周期向量补齐
      state.consumer = new Consumer({ db, loadCfg: () => reloadCfg(), embedFn, llmMod: llm });
      state.consumer.startFull(SPOOL_HANDLERS, dataDir);
      resolve({ server, port: state.port, state, shutdown });
    });
  });
}

// ─── lazy-start 入口: node lib/server.js [dataDir] [uiDir] ───
if (require.main === module) {
  const dataDir = process.argv[2] || path.join(process.env.HOME || '/tmp', '.cw-mem');
  const uiDir = process.argv[3] || path.join(__dirname, '..', 'ui');
  const port = parseInt(process.argv[4] || '37889', 10);
  startServer({ dataDir, uiDir, port })
    .then(({ port, shutdown }) => {
      // eslint-disable-next-line no-console
      console.log('[cw-mem] server running at http://localhost:' + port + ' | Data: ' + dataDir);
      // SIGTERM/SIGINT 由系统直接结束进程, 不会触发 server 的 'close' 事件 ——
      // 不显式处理就没有任何机会 flush 打开的组(spec flush 条件 5)。
      for (const sig of ['SIGTERM', 'SIGINT']) {
        process.on(sig, () => {
          // 兜底: LLM 请求卡住时不让 Ctrl-C 无限等待; unref 使其不自持事件循环
          const forced = setTimeout(() => process.exit(0), 5000);
          forced.unref();
          shutdown().finally(() => { clearTimeout(forced); process.exit(0); });
        });
      }
    })
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.error('[cw-mem] server failed: ' + (e && e.message || e));
      process.exit(1);
    });
}

module.exports = { startServer };

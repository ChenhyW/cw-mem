// lib/server.js — cw-mem HTTP 服务器 + 路由 + 静态 UI + lazy-start 入口。
//
// startServer({ dataDir, uiDir, port }) → Promise<{ server, port }>
//   - 用 lib/db 打开数据库(embedDim 取自当前 config)
//   - 用 lib/config 加载配置
//   - http.createServer + try/catch 路由
//   - port=0 时由 OS 分配, 返回实际端口(供 hook lazy-start 与测试使用)
//
// 路由清单见 plan Task 8。摘要相关端点(/api/prompts/summarize 等)在 T8 先做入队/状态机骨架,
// 实际 LLM 批量在 T10 接入(startSummaryRetryTimer + runSummaryBatch)。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig, saveConfig, mergeLlm } = require('./config');
const { openDb } = require('./db');
const { embed } = require('./embed');
const { userPromptInjection, sessionStartInjection } = require('./recall');
const llm = require('./llm');
const { runStopBatch, runSessionSummary, runVectorRetry } = require('./batch');

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
    const state = { db, cfg, dataDir, uiDir, port: null, server: null, summaryRetryTimer: null, summaryBusy: false, vectorBusy: false };

    function reloadCfg() { state.cfg = loadConfig(dataDir); return state.cfg; }

    function count(table) {
      return db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c;
    }

    function embedFn({ url, model, input }) {
      return embed({ url, model, input, timeoutSeconds: state.cfg.llm.timeoutSeconds || 30 });
    }

    // 摘要重试定时器: 扫描 pending/failed_pending_retry 的 PROMPT 行, 领取后跑 Stop 批量。
    function startSummaryRetryTimer() {
      const intervalSec = (typeof state.cfg.llm.retryIntervalSeconds === 'number' && state.cfg.llm.retryIntervalSeconds > 0)
        ? state.cfg.llm.retryIntervalSeconds : 60;
      if (state.summaryRetryTimer) clearInterval(state.summaryRetryTimer);
      state.summaryRetryTimer = setInterval(() => { runSummaryRetryRound(); runVectorRetryRound(); }, intervalSec * 1000);
      // 不阻塞进程退出(测试/lazy-start 短生命周期场景需要能干净退出)
      state.summaryRetryTimer.unref();
    }

    // 一轮重试: 领取 pending 行(置 generating 防并发), 逐条跑 Stop 批量。
    function runSummaryRetryRound() {
      if (state.summaryBusy) return;
      state.summaryBusy = true;
      try {
        const cfg = reloadCfg();
        if (!cfg.llm || !cfg.llm.enabled || !cfg.llm.apiKey) {
          // LLM 未启用: 把 pending 收敛为 failed_final, 不空转
          const pendings = db.prepare("SELECT id FROM prompts WHERE type='PROMPT' AND summary_status='pending'").all();
          for (const p of pendings) llm.setSummaryStatus(db, p.id, 'failed_final', { error: 'LLM 未启用或缺少 API Key' });
          return;
        }
        const maxAttempts = llm.maxSummaryAttempts(cfg);
        const due = db.prepare(`
          SELECT id FROM prompts
          WHERE type = 'PROMPT' AND COALESCE(response,'') <> ''
            AND COALESCE(summary,'') = ''
            AND (
              summary_status = 'pending'
              OR (summary_status = 'failed_pending_retry' AND COALESCE(retry_attempts,0) < ?)
              OR (summary_status = 'generating'
                  AND summary_updated_at IS NOT NULL
                  AND summary_updated_at < datetime('now', '-' || ? || ' seconds'))
            )
          ORDER BY summary_updated_at ASC, id ASC
          LIMIT 20
        `).all(maxAttempts, 180);
        for (const row of due) {
          // 领取: 置 generating(原子), 防多轮并发
          const claim = db.prepare("UPDATE prompts SET summary_status='generating', summary_updated_at=? WHERE id=? AND summary_status<>'generating'").run(nowIso(), row.id);
          if (claim.changes === 0) continue;
          runStopBatch({ db, cfg, promptRowId: row.id, llmMod: llm, embedFn })
            .catch((e) => { /* runStopBatch 内部已落 failed 状态 */ });
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[cw-mem] summary retry round error: ' + e.message);
      } finally {
        state.summaryBusy = false;
      }
    }

    // 一轮向量补齐: 重算摘要成功但向量缺失/失败的行(不依赖 LLM, ollama 可用即可)
    function runVectorRetryRound() {
      if (state.vectorBusy) return;
      state.vectorBusy = true;
      runVectorRetry({ db, cfg: reloadCfg(), embedFn, limit: 20 })
        .catch(() => {})
        .finally(() => { state.vectorBusy = false; });
    }

    const server = http.createServer((req, res) => {
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = url.pathname;
      try {
        // ─── health ───
        if (pathname === '/api/health' && req.method === 'GET') {
          return json(res, { status: 'ok', db: path.join(dataDir, 'cw-mem.db'), prompts: count('prompts'), sessions: count('sessions') });
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
              startSummaryRetryTimer();
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
            const sid = data.sessionId || '';
            const proj = data.projectDir || null;
            db.prepare('INSERT OR IGNORE INTO sessions (id, project_dir, started_at, last_seen_at) VALUES (?, ?, ?, ?)')
              .run(sid, proj, nowIso(), nowIso());
            if (proj) db.prepare('UPDATE sessions SET project_dir = ?, last_seen_at = ? WHERE id = ?').run(proj, nowIso(), sid);
            return json(res, { status: 'ok' });
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

        // ─── prompts ───
        if (pathname === '/api/prompts' && req.method === 'POST') {
          return readBody(req, (err, data) => {
            if (err) return json(res, { error: err.message }, 400);
            const type = (data.type && data.type !== 'PROMPT') ? data.type : 'PROMPT';
            const toolName = (type === 'TOOL' && data.toolName) ? data.toolName : null;
            const claudePromptId = data.claudePromptId || null;
            const result = db.prepare(
              'INSERT INTO prompts (session_id, prompt, type, tool_name, project_dir, claude_prompt_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
            ).run(data.sessionId || 'unknown', data.prompt || '', type, toolName, data.projectDir || null, claudePromptId, nowIso());
            return json(res, { status: 'ok', id: result.lastInsertRowid });
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
            const promptId = data.promptId || '';
            const sessionId = data.sessionId || '';
            const response = data.response || '';
            if (!promptId || !response) return json(res, { status: 'skipped' });
            const r = db.prepare("UPDATE prompts SET response = ? WHERE claude_prompt_id = ? AND session_id = ? AND type = 'PROMPT'")
              .run(response, promptId, sessionId);
            return json(res, { status: 'ok', changes: r.changes });
          });
        }

        // Stop 入队: 标记 pending, T10 的批量 worker 领取
        if (pathname === '/api/prompts/summarize' && req.method === 'POST') {
          return readBody(req, (err, data) => {
            if (err) return json(res, { error: err.message }, 400);
            const promptId = data.promptId || '';
            const sessionId = data.sessionId || '';
            if (!promptId) return json(res, { status: 'skipped' });
            const row = db.prepare("SELECT * FROM prompts WHERE claude_prompt_id = ? AND session_id = ? AND type = 'PROMPT' AND COALESCE(response,'') <> ''")
              .get(promptId, sessionId);
            if (!row || !row.response) return json(res, { status: 'skipped' });
            const s = row.summary_status || '';
            if (s === 'success' || s === 'generating') return json(res, { status: 'skipped', reason: s });
            const maxAttempts = llm.maxSummaryAttempts(state.cfg);
            if ((row.retry_attempts || 0) >= maxAttempts) return json(res, { status: 'skipped', reason: 'max_retries_reached' });
            llm.setSummaryStatus(db, row.id, 'pending');
            // 立即触发 Stop 批量(异步, 不阻塞 hook); 失败由状态机落 failed, 重试定时器接管
            runStopBatch({ db, cfg: reloadCfg(), promptRowId: row.id, llmMod: llm, embedFn })
              .catch(() => {});
            return json(res, { status: 'ok', queued: true, id: row.id });
          });
        }

        // 手动重试: 重置次数, 立即跑 Stop 批量
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
            runStopBatch({ db, cfg: reloadCfg(), promptRowId: id, llmMod: llm, embedFn })
              .catch(() => {});
            return json(res, { status: 'ok', started: true, id: id });
          });
        }

        // 手动触发一轮向量补齐(异步执行, 立即返回)
        if (pathname === '/api/vector/retry' && req.method === 'POST') {
          runVectorRetryRound();
          return json(res, { status: 'ok', started: true });
        }

        // ─── tool-details ───
        if (pathname === '/api/tool-details' && req.method === 'POST') {
          return readBody(req, (err, data) => {
            if (err) return json(res, { error: err.message }, 400);
            const inputJson = data.toolInput != null ? JSON.stringify(data.toolInput) : null;
            const outputJson = data.toolOutput != null ? JSON.stringify(data.toolOutput) : null;
            const r = db.prepare(
              'INSERT INTO tool_details (prompt_id, input_json, output_json, tool_use_id, tool_name, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
            ).run(data.promptId, inputJson, outputJson, data.toolUseId || null, data.toolName || null, data.durationMs != null ? String(data.durationMs) : null, nowIso());
            return json(res, { status: 'ok', id: r.lastInsertRowid });
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

        // 工具摘要触发(T10 接入实际 LLM); T8 仅返回状态
        if (pathname === '/api/prompts/tool-summary' && req.method === 'POST') {
          return readBody(req, (err, data) => {
            if (err) return json(res, { error: err.message }, 400);
            const toolRowId = data.toolRowId || '';
            if (!toolRowId) return json(res, { status: 'skipped' });
            if (state.cfg.toolSummary.enabled !== true) return json(res, { status: 'skipped', reason: 'toolSummary disabled' });
            llm.setSummaryStatus(db, toolRowId, 'pending');
            return json(res, { status: 'ok', started: true, toolRowId: toolRowId });
          });
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
            const { promptId, sessionId, project, prompt } = data;
            const result = userPromptInjection({ db, embedFn, cfg, project: project || '', prompt: prompt || '' })
              .then(({ text, hits, error }) => {
                if (promptId && sessionId) {
                  db.prepare("UPDATE prompts SET injected_context = ? WHERE claude_prompt_id = ? AND session_id = ? AND type = 'PROMPT'")
                    .run(JSON.stringify({ text, hits, error: error || null }), promptId, sessionId);
                }
                return json(res, { text, hits: hits || [], error: error || null });
              })
              .catch(e => json(res, { text: '', hits: [], error: String(e.message || e) }, 200));
            return result;
          });
        }

        // SessionEnd 触发会话级摘要: 聚合该 session 的 PROMPT result 摘要 → session 摘要 + 向量化
        if (pathname === '/api/sessions/summarize' && req.method === 'POST') {
          return readBody(req, (err, data) => {
            if (err) return json(res, { error: err.message }, 400);
            const sessionId = data.sessionId || '';
            const reason = data.reason || '';
            if (!sessionId) return json(res, { status: 'skipped' });
            db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run(nowIso(), sessionId);
            runSessionSummary({ db, cfg: reloadCfg(), sessionId, llmMod: llm, embedFn })
              .catch(() => {});
            return json(res, { status: 'ok', queued: true, sessionId, reason });
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
    server.on('close', () => {
      if (state.summaryRetryTimer) { clearInterval(state.summaryRetryTimer); state.summaryRetryTimer = null; }
      try { db.close(); } catch (e) { /* 已关闭 */ }
    });
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      state.port = server.address().port;
      startSummaryRetryTimer();
      resolve({ server, port: state.port, state });
    });
  });
}

// ─── lazy-start 入口: node lib/server.js [dataDir] [uiDir] ───
if (require.main === module) {
  const dataDir = process.argv[2] || path.join(process.env.HOME || '/tmp', '.cw-mem');
  const uiDir = process.argv[3] || path.join(__dirname, '..', 'ui');
  const port = parseInt(process.argv[4] || '37889', 10);
  startServer({ dataDir, uiDir, port })
    .then(({ port }) => {
      // eslint-disable-next-line no-console
      console.log('[cw-mem] server running at http://localhost:' + port + ' | Data: ' + dataDir);
    })
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.error('[cw-mem] server failed: ' + (e && e.message || e));
      process.exit(1);
    });
}

module.exports = { startServer };

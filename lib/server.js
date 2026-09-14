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

const { loadConfig, saveConfig, applyPartial } = require('./config');
const { openDb, nextSeq, EMPTY_SESSION_SUMMARY_WHERE } = require('./db');
const { embed } = require('./embed');
const { userPromptInjection, sessionStartInjection, scoreTest } = require('./recall');
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

    // project_dir 归一化到 session 的规范目录(首见 cwd), 返回应写入的 project_dir。
    // hook 上报的 cwd 是**当前 shell 工作目录**, 不是会话启动目录 —— agent 一跑
    // `cd x && ...` 复合命令就漂移, 一个会话被拆成多个"项目", 按目录过滤的语义召回
    // 和会话摘要注入随之被切碎。首见 cwd 一定早于任何工具调用, 等价于启动目录。
    // 幂等: 已有规范目录就直接复用; 空目录不会覆盖非空值。
    //
    // source: 锁只允许"不漂移"的来源写入。TOOL 行的 projectDir 是 PostToolUse 时刻的
    // shell cwd, 会漂移 —— 若它先于 SessionStart/UserPromptSubmit 成功写入
    // (_ensure_server 竞态下 SessionStart 的 POST 失败进 spool, 稍后才成功), 整个 session
    // 就被钉在漂移目录上: 症状从"单 session 内分裂"变成"静默归错项目", 更难发现。
    // 因此 TOOL 来源只读锁、不设锁; 此刻无锁则该行 project_dir 落 NULL(确实未知),
    // 等下一条 PROMPT 设锁。会话行照常创建, last_seen_at 照常续。
    function ensureSessionProject(sessionId, candidate, source) {
      if (!sessionId) return candidate || null;
      const row = db.prepare('SELECT project_dir FROM sessions WHERE id = ?').get(sessionId);
      if (row && row.project_dir) return row.project_dir;
      const mayLock = !!candidate && source !== 'TOOL';
      db.prepare('INSERT OR IGNORE INTO sessions (id, project_dir, started_at, last_seen_at) VALUES (?, ?, ?, ?)')
        .run(sessionId, mayLock ? candidate : null, nowIso(), nowIso());
      if (mayLock) {
        db.prepare("UPDATE sessions SET project_dir = ?, last_seen_at = ? WHERE id = ? AND (project_dir IS NULL OR project_dir = '')")
          .run(candidate, nowIso(), sessionId);
      } else {
        db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(nowIso(), sessionId);
      }
      return mayLock ? candidate : null;
    }

    // POST /api/sessions —— 建/刷新 session; project_dir 首见即锁定, 只续 last_seen_at
    // 调用方只有 SessionStart / UserPromptSubmit / Stop, cwd 都是启动目录不漂移;
    // post-tool-use.sh 也走这个端点但它不再上报 projectDir(那个 cwd 会漂移)。
    function handleSession(data) {
      const sid = data.sessionId || '';
      if (!sid) return { status: 'skipped' };
      ensureSessionProject(sid, data.projectDir || null, 'SESSION');
      db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(nowIso(), sid);
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
      // 落库目录归一化, 不用 hook 的原始 cwd。TOOL 行只读锁不设锁(它的 cwd 会漂移)
      const projDir = ensureSessionProject(data.sessionId || '', data.projectDir || null, type);
      const result = db.prepare(
        'INSERT INTO prompts (session_id, prompt, type, tool_name, project_dir, claude_prompt_id, tool_use_id, tool_target, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(data.sessionId || 'unknown', data.prompt || '', type, toolName, projDir, claudePromptId, toolUseId, toolTarget, nextSeq(db), nowIso());
      return { status: 'ok', id: result.lastInsertRowid };
    }

    // TOOL 卡的"归属提示词"由服务端解析, 不依赖客户端已加载的分页。
    // /api/prompts 按 created_at DESC, 而同一 turn 内 PROMPT 先落库、TOOL 后落库,
    // 所以 TOOL 行的父 PROMPT 常常排在当前分页之外; 项目过滤同样会切走父行
    // (cwd 漂移时父/子 project_dir 不同)。客户端靠已加载列表建映射会大面积漏掉归属。
    // parent_seq 直接取父行的 seq 列 —— 那是落库时的全局唯一序号, 与 PROMPT 卡页脚同号源,
    // 不再用 COUNT 现场推算(推算口径一变两边就对不上, 已踩过一次)。
    // 父行选取的两个约束, 都是真实库踩出来的(以 claude_prompt_id 为准):
    // 1) 排除 <task-notification>。claude 的 prompt_id 在 session 内会重复 —— 一条真实用户
    //    提示词和它之后的多条 task-notification 共用同一个 id。只按 id 取最后一条, 会把工具
    //    调用挂到一条 1 小时后才到达的 task-notification 上(实测 5e35defa 一个 id 对应
    //    1 条真实提示词"开始" + 3 条 task-notification)。
    // 2) 父行必须早于该工具行。同一 id 可能横跨多个 turn, 不加时间约束时真实库有 246 条卡片
    //    的父行晚于工具行本身。
    // 两条约束下覆盖率 1260/1271(99.1%), 指向 task-notification 与时间倒挂均为 0;
    // 匹配不到就返回 null, 不做猜测。
    const parentStmt = db.prepare(
      "SELECT id, seq FROM prompts WHERE type = 'PROMPT' AND session_id = ? AND claude_prompt_id = ?" +
      " AND prompt NOT LIKE '<task-notification>%' AND (created_at < ? OR (created_at = ? AND id < ?))" +
      " ORDER BY created_at DESC, id DESC LIMIT 1");
    function attachParentAttribution(rows) {
      for (const r of rows) {
        if (r.type !== 'TOOL' || !r.claude_prompt_id) { r.parent_id = null; r.parent_seq = null; continue; }
        const par = parentStmt.get(r.session_id, r.claude_prompt_id, r.created_at, r.created_at, r.id);
        if (!par) { r.parent_id = null; r.parent_seq = null; continue; }
        r.parent_id = par.id;
        r.parent_seq = par.seq != null ? par.seq : null;
      }
      return rows;
    }

    // POST /api/prompts/response —— 写回 PROMPT 行的 response
    function handleResponse(data) {
      const promptId = data.promptId || '';
      const sessionId = data.sessionId || '';
      const response = data.response || '';
      if (!promptId || !sessionId || !response) return { status: 'skipped' };
      // 按行主键写回, 不按 claude_prompt_id UPDATE。claude 的 prompt_id 在同 session 内会重复
      // (实测 <task-notification> 与真实用户 prompt 共用同一个 id), 按它 UPDATE 会命中全部
      // 兄弟行, 后写的静默覆盖先写的 —— 真实库里出现 task-notification 的回复覆盖掉 4 小时前
      // 真实 prompt 回复的情况。Stop hook 拿不到 prompts 主键, 所以用单调规则选唯一目标行:
      // 优先本家族里尚无回复的最新行(这一轮), 没有才退到最新一条已回复行(Stop 重放同一轮)。
      const target = db.prepare(
        "SELECT id FROM prompts WHERE session_id = ? AND type = 'PROMPT' AND claude_prompt_id = ? " +
        "ORDER BY (COALESCE(response, '') = '') DESC, id DESC LIMIT 1"
      ).get(sessionId, promptId);
      if (!target) return { status: 'skipped', reason: 'no matching PROMPT row' };
      const r = db.prepare('UPDATE prompts SET response = ? WHERE id = ?').run(response, target.id);
      return { status: 'ok', changes: r.changes };
    }

    // POST /api/prompts/summarize —— 标记 pending 并入队 result 摘要
    function handleSummarize(data) {
      const promptId = data.promptId || '';
      const sessionId = data.sessionId || '';
      if (!promptId || !sessionId) return { status: 'skipped' };
      // 必须落在 handleResponse 刚写入回复的同一行: 取本家族已回复的最新一行。
      // 旧实现按 claude_prompt_id 取首行(最小 id), 会把摘要挂到更早那条 prompt 上,
      // 与同 claude_prompt_id 的兄弟行错位。
      const row = db.prepare(
        "SELECT * FROM prompts WHERE session_id = ? AND claude_prompt_id = ? AND type = 'PROMPT' " +
        "AND COALESCE(response, '') <> '' ORDER BY id DESC LIMIT 1"
      ).get(sessionId, promptId);
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
              // 与 loadConfig 共用 applyPartial: 运行中保存和磁盘加载走同一套范围校验,
              // 非法值忽略而不落盘(那是 injectMaxCount=-3 事故的成因)
              const cfg = reloadCfg();
              const prev = JSON.parse(JSON.stringify(cfg));
              applyPartial(cfg, data);
              // sweep 间隔真变了才重启定时器(旧写法: 只要传了数字就重启, 存同值也重启)
              if (cfg.queue.sweepIntervalSeconds !== prev.queue.sweepIntervalSeconds && state.consumer) {
                state.consumer.restartSweep(SPOOL_HANDLERS, dataDir);
              }
              // 需重启项按实际差异判断(旧写法用 truthy, 存同值也误报需重启)
              const needRestart = cfg.server.port !== prev.server.port
                || cfg.ollama.url !== prev.ollama.url
                || cfg.ollama.embedModel !== prev.ollama.embedModel
                || cfg.ollama.embedDim !== prev.ollama.embedDim;
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
            // 同一套校验: 重启前落盘的配置也必须过 applyPartial, 否则脏值能借道重启路径写进去
            const cfg = reloadCfg();
            applyPartial(cfg, data);
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
          const rows = attachParentAttribution(db.prepare(sql).all(...params));
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
              .then(({ text, hits, error, minCosine, candidates, maxCosine }) => {
                // 诊断字段一并落库: minCosine/candidates/maxCosine 让 UI 区分"无命中"与"阈值高于
                // 语料实际可达相似度", 否则 text 为空时看不出召回是否真的在跑。
                const record = { text, hits: hits || [], error: error || null, minCosine, candidates, maxCosine };
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
              .catch(e => json(res, { text: '', hits: [], error: String(e.message || e), minCosine: cfg.recall.minCosine, candidates: 0, maxCosine: null }, 200));
            return result;
          });
        }

        // 注入探查: 只读 KNN, 不套阈值, 返回原始排序分数 —— UI 用来看"哪些条目差一点就被注入"
        if (pathname === '/api/recall/test' && req.method === 'POST') {
          return readBody(req, (err, data) => {
            if (err) return json(res, { error: err.message }, 400);
            const cfg = reloadCfg();
            return scoreTest({
              db, embedFn, cfg,
              project: data.project || '', prompt: data.prompt || '',
              count: data.count || 5
            }).then(json.bind(null, res))
              .catch(e => json(res, { hits: [], minCosine: cfg.recall.minCosine, candidates: 0, elapsedMs: 0, error: String(e.message || e) }, 200));
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

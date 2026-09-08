// lib/queue.js — cw-mem 进程内内存队列 + 流式工具聚合。
//
// 单进程单消费者: 全局 FIFO + per-session Lane 串行 + per-session Accumulator 累积。
// 纯 DB 写由 server 同步完成(ack 前已提交), 这里只调度 LLM 工作(tool/result/session 摘要)。
// DB 行级状态机始终可重建待办, 启动时由 recover() 重建 —— 见 §11。
//
// 所有本文件新建的定时器都 .unref(): server 可能因 lazy-start 而短生命周期,
// 未 unref 的定时器会让进程在 idle 后无法干净退出。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  runToolGroupSummary, runStopBatch, runSessionSummary, runVectorRetry,
  findSessionsNeedingSummary
} = require('./batch');
const llmDefault = require('./llm');

// 全局 FIFO。单消费者下 shift() 已是原子取头, 无需锁。
class Queue {
  #items = [];
  push(item) { this.#items.push(item); }
  take() { return this.#items.shift() || null; }
  get size() { return this.#items.length; }
}

// per-session 串行链: 同 session 严格 FIFO, 不同 session 可交错。
// 链本身永不 reject —— 否则一次意外异常会让该 session 后续所有任务永久排队不进。
class Lane {
  #tail = Promise.resolve();
  run(fn) {
    const r = this.#tail.then(() => fn(), () => fn());
    this.#tail = r.then(() => {}, () => {});
    return r.then(() => {}, () => {});
  }
}

// per-session 聚合累积器: 当前打开的工具组 + 其静默兜底定时器。
class Accumulator {
  group = null;   // { toolTarget, toolName, ids: [] }
  timer = null;
}

class Consumer {
  #queue = new Queue();
  #lanes = new Map();
  #accs = new Map();
  #idle = true;
  #idleTimer = null;
  #sweepTimer = null;
  #running = false;
  #vectorBusy = false;
  #db;
  #loadCfg;
  #embedFn;
  #llmMod;

  // loadCfg 是函数而非快照: 配置由 UI 即时热更新, 每次判定都读最新值。
  constructor({ db, loadCfg, embedFn, llmMod }) {
    this.#db = db;
    this.#loadCfg = loadCfg;
    this.#embedFn = embedFn;
    this.#llmMod = llmMod || llmDefault;
  }

  cfg() { return this.#loadCfg(); }

  #lane(sid) { if (!this.#lanes.has(sid)) this.#lanes.set(sid, new Lane()); return this.#lanes.get(sid); }
  #acc(sid) { if (!this.#accs.has(sid)) this.#accs.set(sid, new Accumulator()); return this.#accs.get(sid); }

  start() { this.#running = true; this.#wake(); }

  stop() {
    this.#running = false;
    clearTimeout(this.#idleTimer);
    if (this.#sweepTimer) { clearInterval(this.#sweepTimer); this.#sweepTimer = null; }
    for (const a of this.#accs.values()) clearTimeout(a.timer);
  }

  // 启动序列: 排空 spool → 从 DB 重建待办 → 启动消费 + 周期补齐。
  startFull(handlers, dataDir) {
    this.start();
    this.drainSpool(dataDir, handlers);
    this.recover();
    const sweepMs = this.cfg().queue.sweepIntervalSeconds * 1000;
    this.#sweepTimer = setInterval(() => { this.drainSpool(dataDir, handlers); this.vectorSweep(); }, sweepMs);
    this.#sweepTimer.unref();
  }

  push(item) { item._enq = Date.now(); this.#queue.push(item); if (this.#idle) this.#wake(); }

  #wake() { clearTimeout(this.#idleTimer); this.#idle = false; setImmediate(() => this.#loop()); }

  async #loop() {
    if (!this.#running) return;
    for (;;) {
      const item = this.#queue.take();
      if (!item) {
        // 只有关闭时队列为空才轮询; pollMs 仅影响"从空到有"的响应延迟, 不影响处理速度。
        this.#idle = true;
        this.#idleTimer = setTimeout(() => { this.#idleTimer = null; this.#loop(); }, this.cfg().queue.pollMs);
        this.#idleTimer.unref();
        return;
      }
      await this.#lane(item.sessionId).run(() => this.#handle(item));
    }
  }

  queueDepth() { return this.#queue.size; }
  openGroupCount() {
    let n = 0;
    for (const a of this.#accs.values()) if (a.group) n++;
    return n;
  }

  async #handle(item) {
    // ── 非 tool: 先闭合本 session 打开的组, 再处理自己 ──
    // 这保证 result 摘要读到的一定是已完成的 tool 摘要, 而非空结果。
    if (item.kind === 'flush') return this.#flush(item.sessionId);
    if (item.kind === 'result') return (await this.#flush(item.sessionId), this.#runResult(item));
    if (item.kind === 'session') return (await this.#flush(item.sessionId), this.#runSession(item));
    if (item.kind === 'toolgroup') return this.#summarizeGroup(item.sessionId,
      { toolTarget: '', toolName: item.toolName, ids: item.toolRowIds }, item.attempts || 0);

    // ── tool: 累积 / flush 判定 ──
    const acc = this.#acc(item.sessionId);
    const open = acc.group;
    const max = this.cfg().queue.toolGroupMax;

    if (!open) {
      acc.group = { toolTarget: item.toolTarget, toolName: item.toolName, ids: [item.toolRowId] };
      return this.#arm(item.sessionId);
    }
    if (open.toolTarget === item.toolTarget && open.ids.length < max) {
      open.ids.push(item.toolRowId);
      return this.#arm(item.sessionId);
    }
    // 不同文件 或 已满 → 对之前那组做聚合摘要, 用当前 item 开新组
    const closed = acc.group;
    acc.group = null;                                  // 必须在 await 之前: 异常后残留会在旧组上继续累积
    await this.#summarizeGroup(item.sessionId, closed, 0);
    acc.group = { toolTarget: item.toolTarget, toolName: item.toolName, ids: [item.toolRowId] };
    return this.#arm(item.sessionId);
  }

  // 静默兜底: 无新 item 到达多久后强制 flush 打开的组。
  // 防止 turn 在同一文件上结束且 Stop 未触发时消费者永久卡在"等下一条"上 ——
  // 单消费者冻结的不仅是本 session, 还有所有 session 的摘要、向量补齐与恢复扫描。
  #arm(sessionId) {
    const acc = this.#acc(sessionId);
    clearTimeout(acc.timer);
    acc.timer = setTimeout(() => { acc.timer = null; this.push({ kind: 'flush', sessionId }); },
      this.cfg().queue.quiescenceSeconds * 1000);
    acc.timer.unref();
  }

  async #flush(sessionId) {
    const acc = this.#acc(sessionId);
    clearTimeout(acc.timer);
    acc.timer = null;
    if (!acc.group) return;
    const g = acc.group;
    acc.group = null;
    await this.#summarizeGroup(sessionId, g, 0);
  }

  // 契约: runToolGroupSummary 对 LLM 失败/输出非法返回 {status:'failed', retryable}, 不抛
  // (行状态已由 _applyFailure 落库); 仅意外异常才抛, 在此 catch 兜底退避。
  // 退避推迟的是【入队】而非出队 —— 队列里永不存在"未到期"的 item, 不阻塞后续任务。
  async #summarizeGroup(sessionId, g, attempts) {
    try {
      const r = await runToolGroupSummary({
        db: this.#db, cfg: this.cfg(), toolRowIds: g.ids, toolName: g.toolName,
        llmMod: this.#llmMod, embedFn: this.#embedFn
      });
      if (r.status === 'failed' && r.retryable) this.#pushRetry('toolgroup', sessionId, g, attempts);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[cw-mem] 工具组摘要意外异常: ' + ((e && e.message) || e));
      this.#pushRetry('toolgroup', sessionId, g, attempts);
    }
  }

  #pushRetry(kind, sessionId, g, attempts) {
    if ((attempts || 0) >= this.cfg().llm.maxRetries) return;
    const cfg = this.cfg();
    const ms = Math.min((cfg.llm.retryIntervalSeconds || 1) * 2 ** (attempts || 0), 600) * 1000;
    const item = {
      kind, sessionId,
      toolRowIds: g.ids, toolName: g.toolName, toolTarget: g.toolTarget || '',
      attempts: (attempts || 0) + 1
    };
    const t = setTimeout(() => this.push(item), ms);
    t.unref();
  }

  async #runResult(item) {
    const r = await runStopBatch({
      db: this.#db, cfg: this.cfg(), promptRowId: item.promptRowId,
      llmMod: this.#llmMod, embedFn: this.#embedFn
    });
    if (r.status !== 'failed') return;
    // 行级状态机是唯一事实来源: 只重跑仍处于可重试状态的行。
    const row = this.#db.prepare('SELECT summary_status, retry_attempts FROM prompts WHERE id = ?').get(item.promptRowId);
    if (!row || row.summary_status !== 'failed_pending_retry') return;
    if ((row.retry_attempts || 0) >= this.cfg().llm.maxRetries) return;
    const ms = Math.min(
      (this.cfg().llm.retryIntervalSeconds || 1) * 2 ** (row.retry_attempts || 0), 600) * 1000;
    const t = setTimeout(() => this.push({
      kind: 'result', sessionId: item.sessionId, promptRowId: item.promptRowId
    }), ms);
    t.unref();
  }

  // skipped(典型: result 摘要尚未落库)在有限次数内重跑, 替代旧的 SessionEnd 周期轮询。
  async #runSession(item) {
    const r = await runSessionSummary({
      db: this.#db, cfg: this.cfg(), sessionId: item.sessionId,
      llmMod: this.#llmMod, embedFn: this.#embedFn
    });
    if (r.status !== 'skipped') return;
    const n = item.attempts || 0;
    if (n >= 5) return;
    const ms = Math.min(
      (this.cfg().llm.retryIntervalSeconds || 1) * 2 ** n, 600) * 1000;
    const t = setTimeout(() => this.push({ kind: 'session', sessionId: item.sessionId, attempts: n + 1 }), ms);
    t.unref();
  }

  // 启动恢复: 从行级状态机重建全部待办。DB 是事实来源, 内存队列只是加速。
  // 崩溃时未 flush 的组: TOOL 行已在 DB(summary_status=''), 这里扫得到, 不丢。
  recover() {
    const db = this.#db;
    const cfg = this.cfg();
    const maxAttempts = this.#llmMod.maxSummaryAttempts(cfg);

    // 1) 未完成摘要的 TOOL 行: 未触碰 / 可重试 / 卡在 generating 超 180s(视为进程已死)
    const tools = db.prepare(`
      SELECT id, session_id, tool_target, tool_name, summary_status, retry_attempts FROM prompts
      WHERE type = 'TOOL' AND (
        COALESCE(summary_status, '') = ''
        OR summary_status = 'failed'
        OR (summary_status = 'failed_pending_retry' AND COALESCE(retry_attempts, 0) < ?)
        OR (summary_status = 'generating' AND summary_updated_at IS NOT NULL
            AND summary_updated_at < datetime('now', '-180 seconds'))
      ) ORDER BY id`).all(maxAttempts);

    // 按 (session_id, tool_target) 分桶重建 —— 与运行期复合键一致
    const buckets = new Map();
    for (const r of tools) {
      const key = r.session_id + '|' + (r.tool_target || '');
      if (!buckets.has(key)) buckets.set(key, {
        sessionId: r.session_id, toolTarget: r.tool_target || '',
        toolName: r.tool_name || '', ids: []
      });
      buckets.get(key).ids.push(r.id);
    }
    const max = cfg.queue.toolGroupMax;
    for (const b of buckets.values()) {
      for (let i = 0; i < b.ids.length; i += max) {
        this.push({
          kind: 'toolgroup', sessionId: b.sessionId, toolTarget: b.toolTarget,
          toolName: b.toolName, toolRowIds: b.ids.slice(i, i + max), attempts: 0
        });
      }
    }

    // 2) 有待回复但无摘要的 PROMPT 行。含 COALESCE='' 分支: server 在写入 response 后、
    //    到达 /api/prompts/summarize 之前崩溃时状态仍为默认空串, 属最常见的崩溃场景。
    const prompts = db.prepare(`
      SELECT id, session_id FROM prompts
      WHERE type = 'PROMPT' AND COALESCE(response, '') <> '' AND COALESCE(summary_meta, '') = ''
        AND (
          COALESCE(summary_status, '') = '' OR summary_status = 'pending' OR summary_status = 'failed'
          OR (summary_status = 'failed_pending_retry' AND COALESCE(retry_attempts, 0) < ?)
          OR (summary_status = 'generating' AND summary_updated_at IS NOT NULL
              AND summary_updated_at < datetime('now', '-180 seconds'))
        ) ORDER BY id`).all(maxAttempts);
    for (const p of prompts) this.push({ kind: 'result', sessionId: p.session_id, promptRowId: p.id });

    // 3) 会话摘要补齐
    for (const sid of findSessionsNeedingSummary(db, 50)) this.push({ kind: 'session', sessionId: sid, attempts: 0 });
  }

  // 排空本地 spool: hook 连不上 server 时的兜底写入, server 是唯一排空者。
  // handlers: { '/api/xxx': (body) => ... } —— 复用端点的同一份核心逻辑, 避免逻辑分叉。
  drainSpool(dataDir, handlers) {
    if (!dataDir || !handlers) return;
    const spoolDir = path.join(dataDir, 'spool');
    let entries = [];
    try { entries = fs.readdirSync(spoolDir); }
    catch (e) { return; }                               // 目录不存在 = 无事可做, 不是错误
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(spoolDir, f);
      try {
        const lines = fs.readFileSync(full, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          let rec;
          try { rec = JSON.parse(line); } catch (e) { continue; }   // 坏行跳过, 不阻塞整文件
          const h = handlers[rec.path];
          if (h) h(rec.body || {});
          else console.warn('[cw-mem] spool 无对应 handler: ' + rec.path);
        }
        fs.unlinkSync(full);                             // 整文件成功读取才删除
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[cw-mem] spool 排空失败 ' + f + ': ' + ((e && e.message) || e));
      }
    }
  }

  // 向量补齐: 历史失败回填、换嵌入模型后的批量重算。串行防重入。
  vectorSweep() {
    if (this.#vectorBusy) return;
    this.#vectorBusy = true;
    this.#vectorSweepAsync();          // 内部自捕获, 不产生 unhandled rejection
  }

  async #vectorSweepAsync() {
    try {
      await runVectorRetry({ db: this.#db, cfg: this.cfg(), embedFn: this.#embedFn, limit: 20 });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[cw-mem] 向量补齐异常: ' + ((e && e.message) || e));
    } finally {
      this.#vectorBusy = false;
    }
  }

  // 进程关闭 best effort: 同步关闭所有打开的组(不等摘要完成)。
  // 已丢弃的组由 recover() 在下次启动重建, 不丢数据。
  flushAll() {
    const jobs = [];
    for (const [sid, acc] of this.#accs) {
      clearTimeout(acc.timer);
      acc.timer = null;
      if (!acc.group) continue;
      const g = acc.group;
      acc.group = null;
      jobs.push(this.#summarizeGroup(sid, g, 0));
    }
    return Promise.allSettled(jobs);
  }
}

module.exports = { Consumer, Queue, Lane, Accumulator };

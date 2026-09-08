# cw-mem 内存队列 + 流式工具聚合 设计

日期：2026-09-07
状态：已评审通过，待实现
替代/演进自：`2026-09-02-cw-mem-design.md`（本文只覆盖队列与摘要调度部分，DB schema、召回、UI 卡片等其余部分沿用原文）

---

## 1. 背景与问题

cw-mem 通过 5 个 hook 把 Claude 会话写入 SQLite，再由 LLM 做三层摘要（tool 观察 / result 摘要 / session 摘要）并向量化。现状是"hook 同步写 DB + server 直接 fire-and-forget 跑摘要 + 三个轮询补齐"，已确认 6 个缺陷：

| # | 缺陷 | 位置 |
|---|---|---|
| 1 | 同一 PROMPT 行会被两条路径同时摘要（重复 LLM 调用、重复 tool 观察） | `/api/prompts/summarize` 非原子（`server.js:316-326`）vs 定时器 `claim` 原子（`server.js:110`） |
| 2 | `state.summaryBusy` 实际无效——for 循环内 `runStopBatch` 未 `await`，`finally` 立刻置回 | `server.js:82-121` |
| 3 | Stop 批量与最后一批 PostToolUse 竞态：Stop 到达时同 `claude_prompt_id` 下最后一个工具的 `tool_details` 可能未写入，且残缺行不会被重做 | `post-tool-use.sh` 两次 HTTP + `batch.js:112-114` |
| 4 | SessionEnd 与 result 摘要竞态，已用"返回 skipped + 轮询补齐"绕开 | `batch.js:283-286` |
| 5 | `runVectorRetry` 的 60s cutoff 是竞态补丁（防与 `runStopBatch` 的实时向量化重复写） | `batch.js:348-349` |
| 6 | server 宕机期间写入全部丢失——其余 4 个 hook 连不上就 `log.warn` + `suppress()` 退出，不重试、不落地 | 各 hook |

另有 2 个次生问题：

- `server.js:381-390` 的 `POST /api/prompts/tool-summary` 是半死代码：它只设 `summary_status='pending'`，而 `runSummaryRetryRound` 的查询条件是 `type='PROMPT'`，TOOL 行永远进不去。
- `invalid json` 的失败待遇不一致：`batch.js:177-179`（tool_batch）走 `_applyFailure` 可重试，`batch.js:144-146`（tool 单条）与 `batch.js:219-223`（result）直接 `failed_final` 永久放弃——单次畸形输出即永久丢失。

---

## 2. 决策记录

| # | 决策 | 备注 |
|---|---|---|
| D1 | 队列底座 = **内存队列**；DB 做持久化记录 + 恢复索引 | 撤回初版"SQLite `queue` 表"方案 |
| D2 | 消费者 = **server 进程内** | 撤回"独立进程 `lib/worker.js`"：hook 是独立进程，必须经 server 入队；server 挂掉时没人能入队，独立 worker 只剩"server 挂掉时继续消费"一个价值，而该场景由 spool 覆盖 |
| D3 | 入队边界 = **纯 DB 写同步 + 只有 LLM 工作入队** | 撤回"全部写端点入队"：纯 DB 写在 WAL 下微秒级，入队只付代价（payload 双份存储、崩溃后 payload 丢失、hook 拿不到自增 id） |
| D4 | 聚合键 = **`(tool_name, file_path)` 复合键**，替换 `batch.js:192-203` 的"连续同名"分组 | 文件相同则合并，位置无关 |
| D5 | tool 摘要触发 = **流式聚合**（键变化即 flush），不等 turn 回复 | 顺带修掉缺陷 3 与"Stop 丢失 → tool 摘要永久丢失" |
| D6 | 重试 = **保留行级状态机，删除周期 sweep** | 见 §10 |
| D7 | 三个待定项全部做成配置项并在 UI 可设置；**后续所有新增配置一律照此办理** | 见 §14 |

---

## 3. 架构总览

```
hook ──HTTP──> server.js（单进程）
                 │
                 ├─ 同步写 DB（prompts / tool_details / sessions）   ← 微秒级，ack 前已提交
                 ├─ 同步读（/api/recall/*，注入文本回传 Claude）
                 └─ queue.push(item)                                 ← 只有 LLM 工作进队列
                        │
                        ▼ 同一进程内
                     Consumer（lib/queue.js）
                     全局 FIFO + per-session Lane + per-session Accumulator
                        │
                        ├─ tool      → 累积 / flush 判定 → runToolGroupSummary
                        ├─ result    → 先 flush 本 session 打开的组 → runStopBatch
                        └─ session   → 先 flush → runSessionSummary
```

核心不变量：**ack 前 DB 已提交，DB 状态始终足以重建待办**。内存队列崩了不丢数据。

---

## 4. 数据结构（`lib/queue.js`）

```js
class Queue {                              // 全局 FIFO
  #items = [];
  push(it) { this.#items.push(it); }
  take() { return this.#items.shift(); }
  get size() { return this.#items.length; }
}

class Lane {                               // per-session 串行链：同 session 严格 FIFO
  #chain = Promise.resolve();
  run(fn) {
    const r = this.#chain.then(() => fn(), () => fn());   // 无论上一条 resolve/reject 都跑 fn
    this.#chain = r.then(() => {}, () => {});              // 链本身永不 reject
    return r.then(() => {}, () => {});                      // 返回值也永不 reject: 只做串行化, 吞掉 fn 的 rejection, 不让 #loop 死
  }
}

class Accumulator {                        // per-session 打开的组
  group = null;                            // { toolTarget, toolName, ids: [] }
  timer = null;                            // 静默兜底
}

class Consumer {
  #queue = new Queue();
  #lanes = new Map();      // sessionId → Lane
  #accs  = new Map();      // sessionId → Accumulator
  #idle = true;
}
```

`toolTarget = toolName + ' ' + (filePath || '')`（空格分隔）。toolName 取自固定工具名集（`Edit`/`Write`/`Bash`/… 均不含空格），无歧义；不用 NUL 是因为 SQLite 经 `sqlite3_column_text` 取 TEXT 是 NUL 终止的，嵌入 NUL 有被截断的风险。
`Edit` / `Write` / `NotebookEdit` 的 `tool_input.file_path` 可靠存在 → 按文件聚合；`Bash` / `Agent` / MCP / 其他无结构化 `file_path` → 退化为按工具名。**不尝试从 Bash command 正则提文件名**（`lib/skip.js` 已证明此类解析不可靠）。

---

## 5. item kinds（5 种）

```js
{ kind: 'tool',      sessionId, toolRowId, toolTarget }
{ kind: 'result',    sessionId, promptRowId }
{ kind: 'session',   sessionId, attempts = 0 }
{ kind: 'flush',     sessionId }                                  // 静默兜底定时器产生
{ kind: 'toolgroup', sessionId, toolRowIds, toolName, attempts } // 组失败重试产生
```

只有 `tool` / `result` / `session` 由 hook 触发；`flush` 与 `toolgroup` 是合成 item。

---

## 6. 入队点（server.js）

| 端点 | 改动 |
|---|---|
| `/api/tool-details` | 写完 `tool_details` 后 `queue.push({kind:'tool', ...})`。**必须在这里，不在 `/api/prompts`**——`tool_details` 未写完前摘要会拿到空 I/O |
| `/api/prompts`（type=TOOL） | 只多写一列 `tool_target`，不 push |
| `/api/prompts/summarize` | `queue.push({kind:'result', ...})` 替代 `server.js:325` 的直接 `runStopBatch` |
| `/api/sessions/summarize` | `queue.push({kind:'session', ...})` 替代 `server.js:427` |
| `/api/prompts/summarize-retry` | 重置 `retry_attempts` 后 `queue.push({kind:'result', ...})` |
| `/api/prompts/tool-summary` | **删除**（`server.js:381-390`，半死代码） |
| `/api/vector/retry` | 保留，手动触发一轮 vector sweep |

`/api/recall/session` 与 `/api/recall/semantic` 完全不动——它们要把注入文本回传给 Claude，是唯一不能进队列的路径。

---

## 7. hook 改造

| hook | 改动 |
|---|---|
| `session-start.sh` | lazy-start 逻辑抽到 `_ensure_server.sh`，本文件 source |
| `post-tool-use.sh` | `/api/prompts` body 加 `filePath`；`/api/tool-details` body 加 `sessionId` + `filePath`；source `_spool.sh` + `_ensure_server.sh` |
| `stop.sh` | source `_spool.sh` + `_ensure_server.sh` |
| `user-prompt-submit.sh` | source `_spool.sh` + `_ensure_server.sh` |
| `session-end.sh` | source `_spool.sh` + `_ensure_server.sh` |

除 `post-tool-use.sh` 的两个字段外，**其余 hook 无需改动**。

---

## 8. 消费循环

```js
push(item) { this.#queue.push(item); if (this.#idle) this.#wake(); }
#wake() { clearTimeout(this.#idleTimer); this.#idle = false; setImmediate(() => this.#loop()); }

async #loop() {
  for (;;) {
    const item = this.#queue.take();
    if (!item) {
      this.#idle = true;
      this.#idleTimer = setTimeout(() => this.#loop(), this.cfg().queue.pollMs);
      return;
    }
    await this.#lane(item.sessionId).run(() => this.#handle(item));
  }
}
```

队列为空才轮询（`pollMs` 默认 200ms，只影响"从空到有"的响应延迟，不影响处理速度）。

**所有 consumer 定时器必须 `.unref()`**（`#idleTimer`、`Accumulator.timer`、退避 `setTimeout`、sweep 定时器）。现有代码已为此显式处理（`server.js:78` 的 `state.summaryRetryTimer.unref()`），否则这些定时器会让短生命周期的 server 进程（测试、lazy-start）无法干净退出。

### handle：流式聚合

```js
async #handle(item) {
  // ── 非 tool：先闭合本 session 打开的组，再处理自己 ──
  if (item.kind === 'flush')    return this.#flush(item.sessionId);
  if (item.kind === 'result')   return (await this.#flush(item.sessionId), this.#runResult(item));
  if (item.kind === 'session')  return (await this.#flush(item.sessionId), this.#runSession(item));
  if (item.kind === 'toolgroup') return this.#summarizeGroup(item.sessionId,
        { toolTarget: '', toolName: item.toolName, ids: item.toolRowIds }, item.attempts || 0);

  // ── tool：累积 / flush 判定 ──
  const acc = this.#acc(item.sessionId);
  const open = acc.group;

  if (!open) {                                             // 无打开的组 → 开新组，等下一条
    acc.group = { toolTarget: item.toolTarget, toolName: item.toolName, ids: [item.toolRowId] };
    return this.#arm(item.sessionId);
  }
  if (open.toolTarget === item.toolTarget && open.ids.length < MAX_GROUP) {
    open.ids.push(item.toolRowId);                         // 同文件 → 继续等下一条
    return this.#arm(item.sessionId);
  }
  // 不同文件 或 已满 → 对之前那组做聚合摘要，用当前 item 开新组
  const closed = acc.group;
  acc.group = null;                                        // 先摘出, 避免 #summarizeGroup 内部意外异常后旧组残留
  await this.#summarizeGroup(item.sessionId, closed, 0);   // 不抛: LLM 失败已落行状态, 意外异常内部兜底
  acc.group = { toolTarget: item.toolTarget, toolName: item.toolName, ids: [item.toolRowId] };
  return this.#arm(item.sessionId);
}

#arm(sessionId) {                                          // 静默兜底
  const acc = this.#acc(sessionId);
  clearTimeout(acc.timer);
  acc.timer = setTimeout(() => this.push({ kind: 'flush', sessionId }),
                         this.cfg().queue.quiescenceSeconds * 1000);
}

async #flush(sessionId) {
  const acc = this.#acc(sessionId);
  clearTimeout(acc.timer);
  if (!acc.group) return;
  const g = acc.group; acc.group = null;
  await this.#summarizeGroup(sessionId, g, 0);   // 不抛: LLM 失败已落行状态, 意外异常内部兜底
}

// 契约: runToolGroupSummary 对 LLM 失败返回 {status:'failed', retryable}, 不抛(行状态已落);
// 仅对意外异常(DB 损坏等)抛, 在此 catch 兜底退避。重试靠重新入队 toolgroup item, 不阻塞 lane。
async #summarizeGroup(sessionId, g, attempts) {
  let r;
  try { r = await runToolGroupSummary({ db, cfg: this.cfg(), toolRowIds: g.ids, toolName: g.toolName, llmMod, embedFn }); }
  catch (e) {                                              // 意外异常
    if (attempts < this.cfg().llm.maxRetries)
      setTimeout(() => this.push({ kind:'toolgroup', sessionId, toolRowIds: g.ids, toolName: g.toolName, attempts: attempts+1 }),
                 Math.min(this.cfg().llm.retryIntervalSeconds * 2 ** attempts, 600) * 1000).unref();
    return;
  }
  if (r.status === 'failed' && r.retryable && attempts < this.cfg().llm.maxRetries)
    setTimeout(() => this.push({ kind:'toolgroup', sessionId, toolRowIds: g.ids, toolName: g.toolName, attempts: attempts+1 }),
               Math.min(this.cfg().llm.retryIntervalSeconds * 2 ** attempts, 600) * 1000).unref();
}
```

`MAX_GROUP = cfg().queue.toolGroupMax`（默认 6）。

`acc.group = null` 必须在 `await` 之前——异常后残留会导致下一 item 在旧组上继续累积，造成重复摘要。

### flush 触发条件（5 个）

| # | 触发 | 时机 |
|---|---|---|
| 1 | 不同文件到达 | 即时，主路径 |
| 2 | 本 session 的非 tool item 到达（`result`/`session`/`flush`） | 即时，`handle` 开头先 flush |
| 3 | 组满 `toolGroupMax` | 即时 |
| 4 | 静默兜底定时器（默认 30s 无新 item） | 兜底，**防止消费者永久卡在"等下一条"上** |
| 5 | 进程关闭 | best effort，flush 所有打开的组 |

第 4 条是必要的：若 turn 在同一个文件上结束且 Stop 未触发（崩溃 / Ctrl-C），消费者会永远等下一条；且它是单消费者，会冻结**所有** session 的摘要、向量补齐与恢复扫描。

正常情况下**不依赖定时器**：Stop 到达 → `result` item → flush 打开的组 → `runStopBatch` 读已落库的 TOOL 摘要。

### 顺序保证

- **同 session 严格 FIFO**：Lane 串行，语言构造保证，无需任何 SQL
- **不同 session 可交错**：Lane 独立
- **`result` 必在本 session 打开组 flush 之后**：`handle` 开头 `await #flush`
- **`session` 必在本 session 的 `result` 之后**：Lane FIFO
- **退避不阻塞后续任务**：退避推迟的是**入队**而非出队——`setTimeout(() => queue.push(item), backoff)`，队列里永不存在"未到期"的 item

---

## 9. 摘要与聚合（`lib/batch.js`）

### 聚合分桶移出 batch.js

分桶逻辑从 `batch.js:192-203` 移到 Consumer 的 `Accumulator`。batch.js 只负责"给一组 row id，做摘要"。

组数不变量：复合键分组恒 ≤ 连续同名分组（`⌈a/6⌉+⌈b/6⌉ ≥ ⌈(a+b)/6⌉`）。

### 新增 `runToolGroupSummary`

内容 = 现 `batch.js:116-190` 的 `vectorizeTool` + `summarizeToolGroup`，签名改为显式 id 列表：

```js
async function runToolGroupSummary({ db, cfg, toolRowIds, llmMod, embedFn }) {
  // 取 tool_details → _truncate(fieldLimit) → llm.summarize(kind:'tool_batch')
  // → validateObservation → 落首行 summary_meta, 其余行 success 无 meta → 向量化首行
  // 失败时对组内所有行调 _applyFailure(行级状态机已落 retry_attempts / summary_status)
  // 返回 { status:'success'|'failed', retryable: bool }   ← LLM 失败不抛(已落行状态)
  // 仅对意外异常(DB 损坏等)抛, 由 consumer 的 #summarizeGroup 兜底退避
}
```

### `runStopBatch` 删除 tool 阶段，改读已落库摘要

删除 `batch.js:110-204`，替换为：

```js
const done = db.prepare(`
  SELECT summary_meta FROM prompts
  WHERE claude_prompt_id=? AND session_id=? AND type='TOOL'
    AND summary_status='success' AND COALESCE(summary_meta,'')<>''
  ORDER BY id ASC`).all(row.claude_prompt_id, row.session_id);
const toolObsList = done.map(r => {
  let m = null; try { m = JSON.parse(r.summary_meta); } catch (e) { return null; }   // 损坏行跳过, 不让一次坏数据杀死 runStopBatch
  if (!m) return null;
  return { title: m.title, type: m.type, files: m.filesChanged || [] };
}).filter(Boolean);
```

`toolObsText` 渲染（`batch.js:207-215`）不动，字段形状一致。某组失败时 result 摘要拿到更少的观察、`toolObsText` 回落 `'无'`——与现状一致。

### 统一 invalid json 的失败待遇

`batch.js:144-146`（tool 单条）与 `batch.js:219-223`（result）从 `failed_final` 改为 `_applyFailure`，与 `batch.js:177-179`（tool_batch）一致。上限仍受 `llm.maxRetries` 约束，不会无限循环。

### `MAX_TOOL_GROUP`

常量移入配置 `queue.toolGroupMax`，`batch.js` 通过 `cfg` 读取。

---

## 10. 重试分层

| | 机制 | 命运 |
|---|---|---|
| ① LLM 调用失败重试 | `prompts.retry_attempts` + `failed_pending_retry`/`failed_final` + `_applyFailure` | **保留** |
| ② 周期 retry sweep | `runSummaryRetryRound` / `runSessionSummaryRound` / `startSummaryRetryTimer` | **删除** |
| ③ 向量补齐 | `runVectorRetry` | **保留** |

**① 保留的理由**：主要失败模式（ollama 在局域网，网络抖动真实存在）。去掉 = 一次失败即该 turn 永久无摘要，记忆静默不完整。

**重试必须带上限**：队列自动重入 = 无限重试，一个长期不可用的 LLM 会让队列不停空转烧 token。

**计数器必须留在 DB**，不能只放队列 item：
- `recover()` 启动时判断是否重新入队：`failed_pending_retry AND retry_attempts < max`
- UI 卡片要显示 `retry_attempts` / `summary_error`
- 进程重启后只靠 item 计数会让总失败次数超过上限

`llm.retryIntervalSeconds` 语义收窄：**只用于退避计算**（`interval · 2^n`，上限 600s），不再驱动任何定时器。

**② 删除的理由**：
- `runSummaryRetryRound` 的职责 = 队列内退避重入（同进程内 `setTimeout` 不会丢）+ 启动 `recover()`（覆盖进程死亡）
- 它的"LLM 未启用"特判（`server.js:87-91`）也不需要：`_applyFailure` 在 LLM 未启用时直接落 `failed_final`（`batch.js:83-85`），一轮收敛
- `runSessionSummaryRound` 的主因（SessionEnd 竞态）由 Lane FIFO + flush 消除。残余场景（`session` 先跑返回 `skipped`，随后某 `result` 重试才成功）改用**有限重试**替代轮询：

```js
if (r.status === 'skipped' && (item.attempts || 0) < cfg().llm.maxRetries) {
  setTimeout(() => this.push({ kind: 'session', sessionId, attempts: (item.attempts || 0) + 1 }), backoff);
  return;
}
```

`findSessionsNeedingSummary` 只保留给 `recover()` 用。

**③ 保留的理由**：向量化是 best-effort（失败只写 `vector_status='failed'`，不回退摘要），不挂在任何 job 生命周期上，只有幂等重算能收敛。

**保留清单**：`prompts.retry_attempts` / `summary_status` 状态机、`_applyFailure`、`maxSummaryAttempts`、`llm.maxRetries`、`llm.retryIntervalSeconds`、UI 手动重试、`/api/vector/retry`、`runVectorRetry`、`recover()`。

**重试粒度的收益**：现状重试单元是整个 turn，重跑会重新分组导致口径漂移（这轮合并 A+B+C，重试时 B/C 已 success、只剩 A，分组口径变了）。新方案重试单元是**一组工具调用**，row ids 冻结在 item 里整组重跑；组内原子（`summarizeToolGroup` 要么整组成功要么整组 `_applyFailure`），没有"部分成功可跳过" → 口径稳定。

---

## 11. 启动恢复 `recover()`

内存队列开机是空的，DB 状态始终能重建待办：

```js
function recover(db, consumer) {
  // 1. 未完成摘要的 TOOL 行 → 按 (session_id, tool_target) 分桶, 每桶按 toolGroupMax 切片
  //    覆盖三类: '' (从未处理) / failed_pending_retry (重试未超限) / generating 超 180s (崩溃在途)
  //    进程死亡后 #summarizeGroup 的退避 setTimeout 没了, 必须由这里重新入队, 否则这类行永久孤立
  db.prepare(`SELECT id, session_id, tool_target, tool_name, summary_status, retry_attempts, summary_updated_at
              FROM prompts WHERE type='TOOL' AND (
                summary_status = ''
                OR (summary_status='failed_pending_retry' AND COALESCE(retry_attempts,0) < ?)
                OR (summary_status='generating' AND summary_updated_at IS NOT NULL
                    AND summary_updated_at < datetime('now','-' || ? || ' seconds'))
              ) ORDER BY id`).all(maxAttempts, 180);
  //    按 (session_id, tool_target) 分桶, 每桶按 toolGroupMax 切片, 每片 push { kind:'toolgroup', toolRowIds, toolName, sessionId }

  // 2. 需摘要的 PROMPT 行（沿用 runSummaryRetryRound 的条件）
  //    pending / failed_pending_retry 未超限 / generating 超 180s
  //    → 每行 push { kind:'result', promptRowId, sessionId }

  // 3. findSessionsNeedingSummary(db) → 每个 push { kind:'session', sessionId }
}
```

崩溃时未 flush 的组：TOOL 行已在 DB（`summary_status=''`），第 1 条扫得到，**不丢**。

---

## 12. spool 兜底（覆盖缺陷 6）

配置：`queue.spool.enabled`，默认 `false`。

**hook 侧**（新增 `hooks-handlers/_spool.sh`，各 hook source）：

```bash
spool() {                                     # spool <path> <json-body>
  CFG="$CW_MEM_DATA_DIR/config.json"
  # config 不可读/malformed 时 fail-safe = 不 spool(丢弃, 与现状一致), 切不可吞错反而 spool
  [ -f "$CFG" ] && node -e "try{if(JSON.parse(require('fs').readFileSync('$CFG','utf8')).queue?.spool?.enabled!==true)process.exit(1)}catch(e){process.exit(1)}" || exit 1
  mkdir -p "$CW_MEM_DATA_DIR/spool"
  node -e "require('fs').appendFileSync('$CW_MEM_DATA_DIR/spool/$(date +%s%3N)-$$.jsonl', JSON.stringify({path:process.argv[1], body:JSON.parse(process.argv[2])})+'\n')" "$1" "$2"
}

r = post('/api/prompts/summarize', {...})
if (!r.ok) { spool('/api/prompts/summarize', JSON.stringify({...})); log_warn('spooled'); }
```

**server 侧排空**：启动时 + 每个 `sweepIntervalSeconds`：读取 `<dataDir>/spool/*.jsonl` 每行 → 调用对应端点的核心处理函数（`handleToolDetails` / `handleResponse` / `handleSummarize` 等，端点本身也调它，避免逻辑分叉）写库 + `queue.push` + 应用 `payloadMaxBytes` 截断 → 删除文件。

**启动顺序**：drain spool（补写 DB）→ `recover()`（扫描 DB 重建待办）→ start consumer。spool 排空会改 DB 状态，必须在 `recover()` 之前，否则 recover 扫到的是缺了 spool 数据的 DB。

**自举缺口**：spool 由 server 排，但若 server 一直不启动，文件永远躺在盘上（典型：机器重启后第一个 session 的 Stop 已 spooled）。

解法：把 `session-start.sh` 的 lazy-start 抽成 `hooks-handlers/_ensure_server.sh`，让 PostToolUse / Stop / UserPromptSubmit / SessionEnd 也 source 它，并在排空前探测 `<dataDir>/spool/` 是否非空——非空则尝试拉起 server（3s 超时）。

---

## 13. 工具 I/O 截断

配置：`toolSummary.payloadMaxBytes`，默认 `524288`（512KB），`0` = 不截断。

现状 `post-tool-use.sh` 把完整 `resp.stdout` / `stderr` 无上限写入 `tool_details`，一次 `cat 大文件` 或 `npm install` 输出可撑爆 `cw-mem.db`。

截断在 server 接收 `/api/tool-details` 时执行，头尾各半保留。**需新增一个按 UTF-8 字节计量的辅助函数**——`batch.js` 的 `_truncate` 按字符计量（`s.length`），中文/多字节场景下字符数远小于字节数，不能直接复用。

---

## 14. 配置项（D7：全部进 UI）

```js
// lib/config.js — DEFAULT_CONFIG
queue: {
  pollMs: 200,                    // 50–5000
  quiescenceSeconds: 30,          // 5–600
  toolGroupMax: 6,                // 1–20
  sweepIntervalSeconds: 60,       // 10–3600
  spool: { enabled: false }
},
toolSummary: { enabled: false, skipMode: 'on', payloadMaxBytes: 524288 }  // 0–10485760
```

`loadConfig` 全部用 `_intInRange` 校验，非法值静默回落默认值。

**全部「即时生效」，无一需重启**：
- consumer 每个 tick 跑 `loadConfig`
- spool 由 hook 每次调用直接读 `config.json`（先例：`post-tool-use.sh` 读 `toolSummary.enabled` / `skipMode`）
- `payloadMaxBytes` 在 server 接收时读取

`needRestart` 判断不需要改。

**UI（`ui/index.html`）**：`tab-recall` 内新增 `.sg` 分组「队列」，含 `sQueuePollMs` / `sQuiescenceSeconds` / `sToolGroupMax` / `sSweepIntervalSeconds` / `sQueueSpool`；「工具调用摘要」分组新增 `sPayloadMaxBytes`。全部带 `reboot-no` 与 `.help` 说明。JS 侧改 `populateUI`（约 636 行）与 `buildPayload`（约 654 行）。

**后续新增配置一律照此办理**，5 处改动缺一不可：
1. `lib/config.js` `DEFAULT_CONFIG` + `loadConfig` 校验
2. `lib/server.js` `POST /api/config` 写入分支（需重启项计入 `needRestart`）
3. `ui/index.html` 面板 HTML（`.sg` / `.field` / `s` 前缀 id / `reboot-tag` / `.help`）
4. `ui/index.html` `populateUI` + `buildPayload`
5. `ui/index.html` `saveConfig` 的 `needRestart` 判断

---

## 15. 文件改动清单

| 文件 | 改动 |
|---|---|
| `lib/queue.js` **新增** | `Queue` / `Lane` / `Accumulator` / `Consumer`（含 `#handle` 流式聚合）+ `recover()` + vector sweep + spool 排空 |
| `lib/batch.js` | 删除 `runStopBatch` tool 阶段（`110-204`）；`runStopBatch` 改读已落库摘要；新增 `runToolGroupSummary`；统一 `invalid json` 失败待遇；`MAX_TOOL_GROUP` 改读配置 |
| `lib/db.js` | `prompts` 新增 `tool_target TEXT` + 迁移（老行从 `tool_details.input_json` 回填 `file_path`，兜底 `tool_name`） |
| `lib/server.js` | `/api/tool-details`、`/api/prompts/summarize`、`/api/sessions/summarize`、`/api/prompts/summarize-retry` 改为 push；删三个 retry round、三个 busy flag、总控 `setInterval`、`/api/prompts/tool-summary`；启动顺序: drain spool → `recover()` → start consumer；端点核心逻辑抽成 `handleXxx` 函数供 spool drain 复用；新增 `POST /api/config` 的 `queue` / `toolSummary.payloadMaxBytes` 分支；新增 `GET /api/queue`（队列深度、打开的组、最老 item 年龄） |
| `hooks-handlers/post-tool-use.sh` | `/api/prompts` body 加 `filePath`；`/api/tool-details` body 加 `sessionId` + `filePath`；source `_spool.sh` + `_ensure_server.sh` |
| `hooks-handlers/{stop,user-prompt-submit,session-end}.sh` | source `_spool.sh` + `_ensure_server.sh` |
| `hooks-handlers/session-start.sh` | lazy-start 抽到 `_ensure_server.sh` |
| `hooks-handlers/_spool.sh` **新增** | `spool` 函数 |
| `hooks-handlers/_ensure_server.sh` **新增** | lazy-start + spool 非空探测 |
| `lib/config.js` | 新增 `queue` 段 + `toolSummary.payloadMaxBytes` |
| `ui/index.html` | 新增「队列」分组 + payload 上限字段；`populateUI` / `buildPayload` |
| `test/queue.test.js` **新增** | 见 §16 |
| `test/batch.test.js` | `runToolGroupSummary` 单测；`runStopBatch` 改断言"读已落库摘要"；修掉 `batch.test.js:320` 主键冲突夹具 bug（`ins()` 硬编码 `id=1`，两个 session 都插 `id=1` 撞 `prompts` 主键） |

**不新增**：`busy_timeout`（单进程无写竞争）、worker 进程、锁文件、`queue` 表、`depends_on`、任何跨进程 IPC。

---

## 16. 测试计划

`test/queue.test.js`：
- 同文件累积 / 不同文件 flush / 组满 flush / 非 tool item 触发 flush
- 静默兜底定时器 flush（防止永久卡死）
- 跨 session 交错不互相污染
- 退避不阻塞后续任务
- `toolgroup` 重试跳过已 success 行
- `acc.group` 在异常后不残留（无重复摘要）
- `recover()` 重建三类专业待办
- spool 排空 + 删除文件；spool 关闭时不落盘

`test/batch.test.js`：
- `runToolGroupSummary` 单测（落首行、其余行 success 无 meta、向量化首行）
- `runStopBatch` 改为断言"读已落库摘要"，tool 摘要缺失时 `toolObsText` 回落 `'无'`
- `invalid json` 走 `_applyFailure`（tool 单条 / result）
- 修掉 `batch.test.js:320` 既有失败用例

---

## 17. 假设与已知限制

**假设**
1. 同一 turn 内 PostToolUse 全部先于 Stop 触发，SessionEnd 最后。这是流式聚合顺序正确的前提。若 hook 并行派发，同 session 的累积顺序可能抖动。
2. `file_path` 只在 `Edit` / `Write` / `NotebookEdit` 可靠存在；Bash 不解析文件名。

**已知限制**
1. spool 关闭（默认）时，server 宕机期间的写入仍会丢失——缺陷 6 仅在开启 spool 时兜底。
2. spool 开启但 server 长期不启动时，spool 文件留在盘上；由 `_ensure_server.sh` 探测 spool 非空后 lazy-start 缓解，不保证 100%。
3. Stop 丢失时 tool 摘要延迟 = `quiescenceSeconds`。正常 Stop 到达则 0 延迟。
4. 聚合仍顺序敏感：交错到达会产生多个组（但复合键比工具名稳定得多，且组数恒不高于连续同名分组）。
5. 进程崩溃后未 flush 的组由 `recover()` 按 `tool_target` 重新分桶，可能与崩溃时的在飞分组不同——接受。
6. 已存在的 `session_summaries` 行永远不会被重新摘要（沿用现状；`findSessionsNeedingSummary` 只处理无摘要行的 session）。

---

## 18. 非目标（本次不做）

- 多进程 / 多 worker / 跨进程 IPC
- 全局严格 FIFO（跨 session 串行）
- hook 侧 HTTP 重试（由 spool 覆盖）
- 历史数据向量化的自动重算（`runVectorRetry` 保留现状行为）
- Bash command 的文件名解析

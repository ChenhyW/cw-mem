# cw-mem 内存队列 + 流式工具聚合 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **⚠️ 修订记录(2026-09-11):测试夹具里的 `recall.minScore` 已改为 `minCosine`(相似度口径换成余弦)。其余为 2026-09-07 原始计划。**

**Goal:** 用进程内内存队列替代"hook 同步写 + server 直接跑摘要 + 三个轮询补齐"，实现按 `(tool_name, file_path)` 复合键的流式工具聚合，删除周期 sweep、保留行级重试状态机。

**Architecture:** 单进程内 `Consumer`（全局 FIFO + per-session Lane 串行 + per-session Accumulator 累积）。纯 DB 写保持同步（ack 前已提交），只有 LLM 工作进队列。DB 状态始终可重建待办，启动时 `recover()` 重建。流式聚合：tool item 到达按复合键累积，键变化/非 tool item/组满/静默兜底即 flush。

**Tech Stack:** Node.js ≥ 18（class private fields `#`、optional chaining、`node --test`）、better-sqlite3、sqlite-vec、CommonJS。

**Spec:** `docs/superpowers/specs/2026-09-07-cw-mem-queue-design.md`（spec 与本计划一并阅读，计划从 spec 推导）。

## Global Constraints

- 测试框架 `node --test 'test/*.test.js'`，`assert/strict`。所有新测试文件放 `test/*.test.js`。
- CommonJS（`require`/`module.exports`）。私有字段用 `#`。
- 配置项一律按 spec §14 五处改动（config.js DEFAULT+loadConfig、server /api/config、ui HTML、populateUI+buildPayload、saveConfig needRestart）。
- 新增 consumer 定时器必须 `.unref()`（spec §8）。
- 每个 Task 结尾 `npm test` 必须全绿，然后 commit。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `lib/queue.js` **新** | `Queue`/`Lane`/`Accumulator`/`Consumer`（handle/flush/summarizeGroup/arm/loop）+ `recover()` + `drainSpool()` + vector sweep |
| `lib/batch.js` | `runToolGroupSummary`（新）、`runStopBatch` 改读已落库摘要、`_truncateToBytes`（新）、统一 invalid json 失败、`MAX_TOOL_GROUP` 改读 cfg |
| `lib/db.js` | `prompts.tool_target` 列 + 迁移回填 |
| `lib/config.js` | `queue` 段 + `toolSummary.payloadMaxBytes` |
| `lib/server.js` | `handleXxx` 抽取；端点改 push；删 retry round/busy flag/setInterval/tool-summary；启动 drain→recover→start；`/api/config` queue 分支；`GET /api/queue` |
| `hooks-handlers/_spool.sh` **新** | `spool()` 函数 |
| `hooks-handlers/_ensure_server.sh` **新** | lazy-start + spool 非空探测 |
| `hooks-handlers/*.sh` | post-tool-use 加字段 + 各 hook source 两个新文件 |
| `ui/index.html` | 队列分组 + payloadMaxBytes 字段 + populateUI/buildPayload |
| `test/queue.test.js` **新** | 队列单元 + 恢复 + spool + 集成 |
| `test/batch.test.js` | runToolGroupSummary/runStopBatch 新用例 + 修 :320 |

---

## Task 1: 配置项（config.js）

**Files:**
- Modify: `lib/config.js`
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `cfg.queue.{pollMs,quiescenceSeconds,toolGroupMax,sweepIntervalSeconds,spool:{enabled}}`、`cfg.toolSummary.payloadMaxBytes`，供后续所有 Task 消费。

- [x] **Step 1: 写失败测试**

追加到 `test/config.test.js`：

```js
test('loadConfig reads queue section with defaults', () => {
  const { loadConfig } = require('../lib/config');
  const os = require('os'), fs = require('fs'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-cfg-'));
  const cfg = loadConfig(dir);
  assert.equal(cfg.queue.pollMs, 200);
  assert.equal(cfg.queue.quiescenceSeconds, 30);
  assert.equal(cfg.queue.toolGroupMax, 6);
  assert.equal(cfg.queue.sweepIntervalSeconds, 60);
  assert.equal(cfg.queue.spool.enabled, false);
  assert.equal(cfg.toolSummary.payloadMaxBytes, 524288);
  fs.rmSync(dir, { recursive: true });
});

test('loadConfig clamps invalid queue values to defaults', () => {
  const { loadConfig } = require('../lib/config');
  const os = require('os'), fs = require('fs'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-cfg-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    queue: { pollMs: 5, quiescenceSeconds: 9999, toolGroupMax: 0, sweepIntervalSeconds: 1, spool: { enabled: 'yes' } },
    toolSummary: { payloadMaxBytes: -1 }
  }));
  const cfg = loadConfig(dir);
  assert.equal(cfg.queue.pollMs, 200);          // 5 < 50 → 回落
  assert.equal(cfg.queue.quiescenceSeconds, 30);// 9999 > 600 → 回落
  assert.equal(cfg.queue.toolGroupMax, 6);      // 0 < 1 → 回落
  assert.equal(cfg.queue.sweepIntervalSeconds, 60);
  assert.equal(cfg.queue.spool.enabled, false);  // 非布尔 → 回落
  assert.equal(cfg.toolSummary.payloadMaxBytes, 524288);
  fs.rmSync(dir, { recursive: true });
});
```

- [x] **Step 2: 跑测试确认失败**

`npm test -- test/config.test.js 2>&1 | tail -5` → FAIL（`cfg.queue` undefined）。

- [x] **Step 3: 实现**

在 `lib/config.js` 的 `DEFAULT_CONFIG` 里 `toolSummary` 段加 `payloadMaxBytes: 524288`，并在 `ollama` 段后新增 `queue` 段：

```js
  toolSummary: { enabled: false, skipMode: 'on', payloadMaxBytes: 524288 },
  queue: {
    pollMs: 200,                    // 队列为空时的轮询间隔
    quiescenceSeconds: 30,          // 无新 item 多久后强制 flush 打开的组
    toolGroupMax: 6,                // 单组聚合上限
    sweepIntervalSeconds: 60,       // 向量补齐周期
    spool: { enabled: false }       // hook 连不上 server 时的本地兜底
  },
```

在 `loadConfig` 的 `if (parsed.toolSummary) {...}` 块内加：

```js
    if (_intInRange(parsed.toolSummary.payloadMaxBytes, 0, 10485760)) cfg.toolSummary.payloadMaxBytes = parsed.toolSummary.payloadMaxBytes;
```

并在 `if (parsed.ollama) {...}` 之后新增：

```js
  if (parsed.queue) {
    if (_intInRange(parsed.queue.pollMs, 50, 5000)) cfg.queue.pollMs = parsed.queue.pollMs;
    if (_intInRange(parsed.queue.quiescenceSeconds, 5, 600)) cfg.queue.quiescenceSeconds = parsed.queue.quiescenceSeconds;
    if (_intInRange(parsed.queue.toolGroupMax, 1, 20)) cfg.queue.toolGroupMax = parsed.queue.toolGroupMax;
    if (_intInRange(parsed.queue.sweepIntervalSeconds, 10, 3600)) cfg.queue.sweepIntervalSeconds = parsed.queue.sweepIntervalSeconds;
    if (parsed.queue.spool && typeof parsed.queue.spool.enabled === 'boolean') cfg.queue.spool.enabled = parsed.queue.spool.enabled;
  }
```

- [x] **Step 4: 跑测试确认通过**

`npm test -- test/config.test.js` → PASS。

- [x] **Step 5: commit**

`git add lib/config.js test/config.test.js && git commit -m "feat(config): 新增 queue 段 + toolSummary.payloadMaxBytes"`

---

## Task 2: DB 迁移 tool_target（db.js）

**Files:**
- Modify: `lib/db.js`（`_migrate` + `_addColumnIfMissing`）
- Test: `test/db.test.js`

**Interfaces:**
- Produces: `prompts.tool_target TEXT` 列；老行回填。`runToolGroupSummary` 与 `recover()` 依赖此列分桶。

- [x] **Step 1: 写失败测试**

追加到 `test/db.test.js`：

```js
test('prompts has tool_target column and backfills from tool_details', () => {
  const { openDb } = require('../lib/db');
  const os = require('os'), fs = require('fs'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-db-'));
  const { db } = openDb(dir, 4);
  // 手造一个老 TOOL 行(无 tool_target) + tool_details 带 file_path
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, tool_name, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(1, 's1', 'cp1', '/p', 'TOOL', 'Write', '2026-09-03T00:00:00Z');
  db.prepare("INSERT INTO tool_details(prompt_id, tool_name, input_json, created_at) VALUES (?,?,?,?)")
    .run(1, 'Write', '{"path":"/abs/lib/batch.js"}', '2026-09-03T00:00:00Z');
  // 触发回填: reopen
  db.close();
  const { db: db2 } = openDb(dir, 4);
  const row = db2.prepare("SELECT tool_target FROM prompts WHERE id=1").get();
  assert.equal(row.tool_target, 'Write\x00/abs/lib/batch.js');
  // Bash 无 file_path → 兜底 tool_name
  db2.prepare("INSERT INTO prompts(id, session_id, project_dir, type, tool_name, created_at) VALUES (?,?,?,?,?,?)")
    .run(2, 's1', '/p', 'TOOL', 'Bash', '2026-09-03T00:00:01Z');
  db2.prepare("INSERT INTO tool_details(prompt_id, tool_name, input_json, created_at) VALUES (?,?,?,?)")
    .run(2, 'Bash', '{"command":"ls"}', '2026-09-03T00:00:01Z');
  db2.close();
  const { db: db3 } = openDb(dir, 4);
  assert.equal(db3.prepare("SELECT tool_target FROM prompts WHERE id=2").get().tool_target, 'Bash\x00');
  fs.rmSync(dir, { recursive: true });
});
```

- [x] **Step 2: 跑测试确认失败**

`npm test -- test/db.test.js 2>&1 | tail -5` → FAIL（无 `tool_target` 列）。

- [x] **Step 3: 实现**

在 `lib/db.js` 的 `_migrate` 里，紧跟现有 `prompts` 索引创建之后、`_addColumnIfMissing(... 'vector_error' ...)` 之后，加：

```js
  _addColumnIfMissing(db, 'prompts', 'tool_target', 'TEXT');
```

并在 `_migrate` 末尾（清理空摘要那段之后）加回填：

```js
  // 回填历史 TOOL 行的 tool_target(复合键 tool_name + 空格 + file_path), 供流式聚合分桶
  if (db.prepare("SELECT COUNT(*) c FROM prompts WHERE type='TOOL' AND tool_target IS NULL").get().c > 0) {
    const rows = db.prepare(`SELECT p.id, p.tool_name, td.input_json
      FROM prompts p LEFT JOIN tool_details td ON td.prompt_id = p.id
      WHERE p.type='TOOL' AND p.tool_target IS NULL`).all();
    const upd = db.prepare('UPDATE prompts SET tool_target = ? WHERE id = ?');
    for (const r of rows) {
      let fp = '';
      try { const o = JSON.parse(r.input_json || '{}'); fp = o.file_path || o.path || ''; } catch (e) {}
      // 复合键 toolName + ' ' + filePath(空格分隔; toolName 取自固定工具名集, 不含空格, 无歧义)
      upd.run((r.tool_name || '') + ' ' + (fp || ''), r.id);
    }
  }
```

> 分隔符用空格而非 NUL：SQLite 经 `sqlite3_column_text` 取 TEXT 是 NUL 终止的，嵌入 NUL 有被截断的风险；空格对固定工具名集（`Edit`/`Write`/`Bash`/… 均不含空格）无歧义。

- [x] **Step 4: 跑测试确认通过**

`npm test -- test/db.test.js` → PASS。

- [x] **Step 5: commit**

`git add lib/db.js test/db.test.js && git commit -m "feat(db): prompts 新增 tool_target 列 + 历史回填"`

---

## Task 3: batch.js — runToolGroupSummary + _truncateToBytes

**Files:**
- Modify: `lib/batch.js`
- Test: `test/batch.test.js`

**Interfaces:**
- Consumes: `storeEmbedding`（vector.js）、`llm.summarize`/`validateObservation`/`setSummaryStatus`/`maxSummaryAttempts`
- Produces: `runToolGroupSummary({db, cfg, toolRowIds, llmMod, embedFn})` → `{status:'success'|'failed', retryable: bool}`；`_truncateToBytes(s, maxBytes)` 导出。

- [x] **Step 1: 写失败测试**

追加到 `test/batch.test.js`（用现有 `freshDb`/`makeLlmMod`/`fakeEmbed`/`baseCfg`；`baseCfg` 加 `queue:{toolGroupMax:6,...}` 见 Step 3a）：

```js
test('runToolGroupSummary writes meta to first row, others success-no-meta, vectorizes first', async () => {
  const { runToolGroupSummary } = require('../lib/batch');
  const { db } = freshDb();
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  for (const id of [2,3,4]) {
    db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, tool_name, tool_target, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, 's1', 'cp1', '/p', 'TOOL', 'Write', 'Write\x00/a.js', '2026-09-03T00:00:0'+id+'Z');
    db.prepare("INSERT INTO tool_details(prompt_id, tool_name, input_json, output_json, created_at) VALUES (?,?,?,?,?,?)")
      .run(id, 'Write', '{"path":"/a.js"}', '{"ok":true}', '2026-09-03T00:00:0'+id+'Z');
  }
  const r = await runToolGroupSummary({ db, cfg: baseCfg, toolRowIds: [2,3,4], llmMod: makeLlmMod(), embedFn: fakeEmbed });
  assert.equal(r.status, 'success');
  const first = db.prepare("SELECT summary_meta, summary_status, vector_status FROM prompts WHERE id=2").get();
  assert.ok(first.summary_meta, '首行应落 summary_meta');
  assert.equal(first.summary_status, 'success');
  assert.equal(first.vector_status, 'success');
  for (const id of [3,4]) {
    const row = db.prepare("SELECT summary_meta, summary_status FROM prompts WHERE id=?").get(id);
    assert.equal(row.summary_status, 'success');
    assert.ok(!row.summary_meta, '非首行不应落 meta');
  }
});
```

并在文件末加 `_truncateToBytes` 测试：

```js
test('_truncateToBytes truncates by UTF-8 bytes head/tail', () => {
  const { _truncateToBytes } = require('../lib/batch');
  // 6 个中文 = 18 字节; 截到 10 字节
  const out = _truncateToBytes('中文中文中文', 10);
  assert.ok(Buffer.byteLength(out) <= 10 + 40, '不超过上限+省略符');
  assert.ok(out.includes('…') || out.includes('condensed'), '含截断标记');
  assert.equal(_truncateToBytes('abc', 10), 'abc', '不超限原样返回');
  assert.equal(_truncateToBytes('abc', 0), 'abc', '0 = 不截断');
});
```

- [x] **Step 2: 跑测试确认失败**

`npm test -- test/batch.test.js 2>&1 | tail -5` → FAIL（`runToolGroupSummary`/`_truncateToBytes` 未导出）。

- [x] **Step 3a: 更新 baseCfg**

在 `test/batch.test.js` 顶部 `baseCfg` 加 `queue` 段：

```js
const baseCfg = {
  llm: { enabled: true, apiKey: 'sk-x', model: 'm', apiBase: 'http://x', timeoutSeconds: 5, maxRetries: 3, retryIntervalSeconds: 1 },
  ollama: { url: 'http://x', embedModel: 'm', embedDim: 4 },
  toolSummary: { enabled: true, skipMode: 'on', payloadMaxBytes: 524288 },
  recall: { topK: 5, minCosine: 0, injectMaxCount: 8, injectMaxTokens: 800 },
  queue: { pollMs: 50, quiescenceSeconds: 0.05, toolGroupMax: 6, sweepIntervalSeconds: 60, spool: { enabled: false } }
};
```

- [x] **Step 3b: 实现 _truncateToBytes**

在 `lib/batch.js` 的 `_truncate` 之后加：

```js
// 按 UTF-8 字节计量截断(maxBytes=0 表示不截断), 头尾各半保留, 风格同 _truncate。
// _truncate 按字符(s.length)计量, 中文场景字符数远小于字节数, 不能直接复用。
function _truncateToBytes(s, maxBytes) {
  if (!s) return '';
  s = typeof s === 'string' ? s : JSON.stringify(s);
  if (maxBytes <= 0) return s;
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  const half = Math.floor((maxBytes - 20) / 2);
  const head = buf.subarray(0, half).toString('utf8');           // 可能截断多字节首字节, toString 丢弃残缺尾
  const tail = buf.subarray(buf.length - half).toString('utf8'); // 同上, 丢弃残缺首
  return head + '\n...[condensed ' + (buf.length - maxBytes) + ' bytes]...\n' + tail;
}
```

- [x] **Step 3c: 实现 runToolGroupSummary**

在 `lib/batch.js` 里，把现有 `runStopBatch` 内的 `vectorizeTool` 与 `summarizeToolGroup` 抽出，改写为独立函数（签名显式 id 列表）。放在 `runStopBatch` 之前：

```js
// 取一组 TOOL 行, 合并提炼为一条 observation, 落首行 summary_meta + 向量化首行。
// 失败时对组内所有行调 _applyFailure(行级状态机已落 retry_attempts/summary_status)。
// 返回 { status:'success'|'failed', retryable: bool }  ← LLM 失败不抛(已落行状态), 仅意外异常抛。
async function runToolGroupSummary({ db, cfg, toolRowIds, llmMod, embedFn }) {
  if (!toolRowIds || !toolRowIds.length) return { status: 'success', retryable: false };
  const rows = db.prepare(`SELECT p.id, p.tool_name, p.project_dir, td.input_json, td.output_json
    FROM prompts p LEFT JOIN tool_details td ON td.prompt_id = p.id
    WHERE p.id IN (${toolRowIds.map(()=>'?').join(',')}) ORDER BY p.id ASC`).all(...toolRowIds);
  const first = rows[0];
  if (!first) return { status: 'success', retryable: false };
  const fieldLimit = (cfg.llm && cfg.llm.summaryFieldLimit) || 2000;
  const timeoutSec = (cfg.llm && cfg.llm.timeoutSeconds) || 30;
  const project = first.project_dir || '';
  const toolName = first.tool_name || '';
  for (const r of rows) llmMod.setSummaryStatus(db, r.id, 'generating');
  try {
    const calls = rows.map(r => ({
      input: _truncate(r.input_json || '', fieldLimit),
      output: _truncate(r.output_json || '', fieldLimit)
    }));
    const text = await llmMod.summarize({
      llm: cfg.llm, kind: 'tool_batch',
      fields: { tool_name: toolName, count: String(rows.length), calls: JSON.stringify(calls) },
      timeoutSeconds: timeoutSec
    });
    const parsed = _parseJsonSafe(text);
    const obs = parsed ? llmMod.validateObservation(parsed) : null;
    if (!obs) {
      for (const r of rows) _applyFailure(db, r, 'invalid tool batch observation json', cfg, llmMod);
      return { status: 'failed', retryable: true };
    }
    db.prepare("UPDATE prompts SET summary_meta = ?, summary = ? WHERE id = ?").run(JSON.stringify(obs), _toolLegacyText(obs), first.id);
    llmMod.setSummaryStatus(db, first.id, 'success', { error: null });
    for (let i = 1; i < rows.length; i++) llmMod.setSummaryStatus(db, rows[i].id, 'success', { error: null });
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
      console.warn('[cw-mem] tool#' + first.id + ' 向量化失败(摘要已成功,不回退): ' + (ve && ve.message));
    }
    return { status: 'success', retryable: false };
  } catch (e) {
    for (const r of rows) _applyFailure(db, r, e.message || String(e), cfg, llmMod);
    return { status: 'failed', retryable: true };
  }
}
```

更新 `module.exports`：`module.exports = { runStopBatch, runSessionSummary, runVectorRetry, findSessionsNeedingSummary, runToolGroupSummary, _truncateToBytes };`

- [x] **Step 4: 跑测试确认通过**

`npm test -- test/batch.test.js` → 新用例 PASS（旧 `runStopBatch` 用例可能仍 PASS，因为 tool 阶段还没删——见 Task 4）。

- [x] **Step 5: commit**

`git add lib/batch.js test/batch.test.js && git commit -m "feat(batch): 抽出 runToolGroupSummary + _truncateToBytes"`

---

## Task 4: batch.js — runStopBatch 改读已落库摘要 + 统一 invalid json + 修 :320

**Files:**
- Modify: `lib/batch.js`（删除 tool 阶段 `110-204`、改读、invalid json）
- Test: `test/batch.test.js`

**Interfaces:**
- Consumes: 已落库的 `prompts.summary_meta`（TOOL 行，由 `runToolGroupSummary` 产出）
- Produces: `runStopBatch` 只做 result 摘要 + 向量化。

- [x] **Step 1: 写失败测试**

替换/追加（旧的 `runStopBatch writes tool obs + result summary` 用例要改，因为 tool 阶段删了）：

```js
test('runStopBatch reads pre-seeded tool summaries into result summary', async () => {
  const { db } = freshDb();
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, prompt, response, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(1, 's1', 'cp1', '/p', 'PROMPT', '做某事', 'final response', '2026-09-03T00:00:00Z');
  // 预置已摘要的 TOOL 行(runToolGroupSummary 的产物)
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, tool_name, summary_status, summary_meta, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(2, 's1', 'cp1', '/p', 'TOOL', 'Write', 'success', JSON.stringify({title:'写 a.js', type:'change', filesChanged:['a.js']}), '2026-09-03T00:00:01Z');
  const r = await runStopBatch({ db, cfg: baseCfg, promptRowId: 1, llmMod: makeLlmMod(), embedFn: fakeEmbed });
  assert.equal(r.status, 'success');
  const p = db.prepare("SELECT summary_status, summary_meta FROM prompts WHERE id=1").get();
  assert.equal(p.summary_status, 'success');
  assert.ok(p.summary_meta);
});

test('runStopBatch toolObsText falls back to 无 when no tool summaries', async () => {
  const { db } = freshDb();
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, prompt, response, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(1, 's1', 'cp1', '/p', 'PROMPT', '做某事', 'resp', '2026-09-03T00:00:00Z');
  const r = await runStopBatch({ db, cfg: baseCfg, promptRowId: 1, llmMod: makeLlmMod(), embedFn: fakeEmbed });
  assert.equal(r.status, 'success');  // 无 tool 摘要也能产 result 摘要
});

test('runStopBatch invalid result json becomes retryable failure not failed_final', async () => {
  const { db } = freshDb();
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, prompt, response, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(1, 's1', 'cp1', '/p', 'PROMPT', '做某事', 'resp', '2026-09-03T00:00:00Z');
  const llmMod = makeLlmMod();
  llmMod.summarize = async () => 'not json at all';
  const r = await runStopBatch({ db, cfg: baseCfg, promptRowId: 1, llmMod, embedFn: fakeEmbed });
  const p = db.prepare("SELECT summary_status FROM prompts WHERE id=1").get();
  assert.notEqual(p.summary_status, 'failed_final', 'invalid json 应可重试, 不应永久放弃');
});
```

- [x] **Step 2: 跑测试确认失败**

`npm test -- test/batch.test.js 2>&1 | tail -10` → 旧 `runStopBatch writes tool obs...` 用例 FAIL（tool 阶段还在但行为变了？实际还没改，先删旧用例）。

先删除旧的 `runStopBatch writes tool obs + result summary + 3 memories` 用例（它依赖内联 tool 阶段），以及任何依赖内联 tool 阶段的旧用例。保留与 runSessionSummary/runVectorRetry 相关的用例。

- [x] **Step 3: 实现 — 删除 tool 阶段，改读**

在 `lib/batch.js` 的 `runStopBatch` 内，删除从 `// ── 1. tool 观察(可选) ──`（约 `110` 行）到 tool 阶段结束（`}` 闭合，约 `204` 行）的整段（含 `vectorizeTool`/`summarizeOneTool`/`summarizeToolGroup`/分组循环，这些已由 Task 3 的 `runToolGroupSummary` 取代）。替换为读已落库摘要：

```js
    // tool 观察已由 Consumer 的 runToolGroupSummary 落库; 这里只读出来拼 result 模板
    const done = db.prepare(`
      SELECT summary_meta FROM prompts
      WHERE claude_prompt_id = ? AND session_id = ? AND type = 'TOOL'
        AND summary_status = 'success' AND COALESCE(summary_meta, '') <> ''
      ORDER BY id ASC`).all(row.claude_prompt_id, row.session_id);
    const toolObsList = done.map(r => {
      let m = null; try { m = JSON.parse(r.summary_meta); } catch (e) { return null; }   // 损坏行跳过
      if (!m) return null;
      return { title: m.title, type: m.type, files: m.filesChanged || [] };
    }).filter(Boolean);
```

`toolObsText` 渲染（约 `207-215`）保持不变。

- [x] **Step 4: 实现 — invalid json 统一**

把 result 摘要处的 `if (!parsed) { setSummaryStatus(...'failed_final'...); return {status:'failed'} }`（约 `219-223`）改为：

```js
    if (!parsed) { _applyFailure(db, row, 'invalid result summary json', cfg, llmMod); return { status: 'failed', reason: 'invalid json' }; }
```

（`_applyFailure` 已在文件内定义；它按 `retry_attempts` 决定 `failed_pending_retry`/`failed_final`。）

- [x] **Step 5: 修 :320 夹具 bug**

在 `test/batch.test.js` 的 `findSessionsNeedingSummary picks only ended sessions...` 用例里，`ins()` 的 INSERT 把硬编码 `id=1` 去掉（让 AUTOINCREMENT 自增），改为：

```js
  const ins = (id, ended, hasSummary) => {
    db.prepare("INSERT INTO sessions(id, project_dir, ended_at) VALUES(?,?,?)").run(id, '/p', ended);
    if (hasSummary) {
      db.prepare("INSERT INTO prompts(session_id, project_dir, type, summary_meta, created_at) VALUES(?,?,?,?,?)")
        .run(id, '/p', 'PROMPT', '{"request":"x"}', '2026-09-03T00:00:00Z');
    }
  };
```

- [x] **Step 6: 跑全部测试确认通过**

`npm test` → 全绿（含 db/config/embed/llm/recall/server/skip/vector/batch）。

- [x] **Step 7: commit**

`git add lib/batch.js test/batch.test.js && git commit -m "feat(batch): runStopBatch 改读已落库 tool 摘要 + 统一 invalid json 重试 + 修 :320"`

---

## Task 5: queue.js — 核心数据结构 + Consumer + handle/flush/summarizeGroup

**Files:**
- Create: `lib/queue.js`
- Test: `test/queue.test.js`

**Interfaces:**
- Consumes: `runToolGroupSummary`/`runStopBatch`/`runSessionSummary`（batch.js）、`llm`/`embed`
- Produces: `class Consumer`，构造接收 `{db, loadCfg, embedFn, llmMod}`，方法 `push(item)`、`start()`、`stop()`、`drainSpool()`、`recover()`；`module.exports = { Consumer, Queue, Lane, Accumulator }`。

- [x] **Step 1: 写失败测试**

新建 `test/queue.test.js`：

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { openDb } = require('../lib/db');
const { Consumer } = require('../lib/queue');

function freshDb(dim = 4) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-q-')); return { dir, ...openDb(dir, dim) }; }
// 复用 batch.test.js 的 fake; 为独立, 此处内联一个最小版
function makeCtx(db, { toolFail = false } = {}) {
  const llmMod = {
    summarize: async ({ kind }) => {
      if (kind === 'tool_batch') return JSON.stringify({ title:'批量改', type:'change', concepts:['x'], filesChanged:['a.js'], result:'ok', sideEffect:'' });
      if (kind === 'result')     return JSON.stringify({ request:'r', investigated:'', learned:'', completed:'', next_steps:'', notes:'' });
      if (kind === 'session')    return JSON.stringify({ request:'r', investigated:'', learned:'', completed:'', next_steps:'', notes:'' });
      throw new Error('kind '+kind);
    },
    validateObservation: require('../lib/llm').validateObservation,
    setSummaryStatus: require('../lib/llm').setSummaryStatus,
    maxSummaryAttempts: () => 3
  };
  const embedFn = async () => [[0.1,0.2,0.3,0.4]];
  const cfg = () => ({
    llm: { enabled:true, apiKey:'sk', model:'m', apiBase:'http://x', timeoutSeconds:5, maxRetries:3, retryIntervalSeconds:0.01, summaryFieldLimit:2000 },
    ollama: { url:'http://x', embedModel:'m', embedDim:4 },
    toolSummary: { enabled:true, skipMode:'on', payloadMaxBytes:524288 },
    queue: { pollMs:20, quiescenceSeconds:0.02, toolGroupMax:6, sweepIntervalSeconds:60, spool:{enabled:false} }
  });
  return { llmMod, embedFn, cfg };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

test('same-file tools accumulate, different file flushes previous group', async () => {
  const { db, dir } = freshDb();
  const { llmMod, embedFn, cfg } = makeCtx(db);
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  // 两个 Write /a.js, 再一个 Write /b.js
  for (const [id, fp] of [[2,'/a.js'],[3,'/a.js'],[4,'/b.js']]) {
    db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, tool_name, tool_target, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, 's1', 'cp1', '/p', 'TOOL', 'Write', 'Write\x00'+fp, '2026-09-03T00:00:0'+id+'Z');
    db.prepare("INSERT INTO tool_details(prompt_id, tool_name, input_json, output_json, created_at) VALUES (?,?,?,?,?)")
      .run(id, 'Write', '{"path":"'+fp+'"}', '{}', '2026-09-03T00:00:0'+id+'Z');
  }
  const c = new Consumer({ db, loadCfg: cfg, embedFn, llmMod });
  c.start();
  c.push({ kind:'tool', sessionId:'s1', toolRowId:2, toolTarget:'Write\x00/a.js' });
  c.push({ kind:'tool', sessionId:'s1', toolRowId:3, toolTarget:'Write\x00/a.js' });
  c.push({ kind:'tool', sessionId:'s1', toolRowId:4, toolTarget:'Write\x00/b.js' });
  await sleep(150);
  c.stop();
  // /a.js 组(id 2,3): 首行 2 落 meta, 3 success 无 meta; /b.js 组: 4 落 meta
  const r2 = db.prepare("SELECT summary_meta, summary_status FROM prompts WHERE id=2").get();
  const r3 = db.prepare("SELECT summary_meta, summary_status FROM prompts WHERE id=3").get();
  const r4 = db.prepare("SELECT summary_meta, summary_status FROM prompts WHERE id=4").get();
  assert.ok(r2.summary_meta, '组1首行应落 meta');
  assert.equal(r3.summary_status, 'success'); assert.ok(!r3.summary_meta, '组1非首行无 meta');
  assert.ok(r4.summary_meta, '组2首行应落 meta');
  fs.rmSync(dir, { recursive: true });
});

test('non-tool item flushes open group first', async () => {
  const { db, dir } = freshDb();
  const { llmMod, embedFn, cfg } = makeCtx(db);
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, prompt, response, created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(1, 's1', 'cp1', '/p', 'PROMPT', '做某事', 'resp', '2026-09-03T00:00:00Z');
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, tool_name, tool_target, created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(2, 's1', 'cp1', '/p', 'TOOL', 'Write', 'Write\x00/a.js', '2026-09-03T00:00:01Z');
  db.prepare("INSERT INTO tool_details(prompt_id, tool_name, input_json, output_json, created_at) VALUES(?,?,?,?,?)")
    .run(2, 'Write', '{"path":"/a.js"}', '{}', '2026-09-03T00:00:01Z');
  const c = new Consumer({ db, loadCfg: cfg, embedFn, llmMod });
  c.start();
  c.push({ kind:'tool', sessionId:'s1', toolRowId:2, toolTarget:'Write\x00/a.js' });
  c.push({ kind:'result', sessionId:'s1', promptRowId:1 });
  await sleep(150);
  c.stop();
  assert.ok(db.prepare("SELECT summary_meta FROM prompts WHERE id=2").get().summary_meta, 'tool 组在 result 前已 flush');
  assert.equal(db.prepare("SELECT summary_status FROM prompts WHERE id=1").get().summary_status, 'success', 'result 摘要完成');
  fs.rmSync(dir, { recursive: true });
});

test('summarizeGroup LLM failure does not throw, schedules retry', async () => {
  const { db, dir } = freshDb();
  let ctx = makeCtx(db);
  ctx.llmMod.summarize = async () => { throw new Error('ollama down'); };
  const { llmMod, embedFn, cfg } = ctx;
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, tool_name, tool_target, created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(2, 's1', 'cp1', '/p', 'TOOL', 'Write', 'Write\x00/a.js', '2026-09-03T00:00:01Z');
  db.prepare("INSERT INTO tool_details(prompt_id, tool_name, input_json, output_json, created_at) VALUES(?,?,?,?,?)")
    .run(2, 'Write', '{"path":"/a.js"}', '{}', '2026-09-03T00:00:01Z');
  const c = new Consumer({ db, loadCfg: cfg, embedFn, llmMod });
  c.start();
  c.push({ kind:'tool', sessionId:'s1', toolRowId:2, toolTarget:'Write\x00/a.js' });
  c.push({ kind:'result', sessionId:'s1', promptRowId:999 }); // 触发 flush(999 不存在, runStopBatch 会 not_found, 但 flush 已发生)
  await sleep(150);
  c.stop();
  const r = db.prepare("SELECT summary_status FROM prompts WHERE id=2").get();
  assert.equal(r.summary_status, 'failed_pending_retry', 'LLM 失败落可重试状态, 不抛');
  fs.rmSync(dir, { recursive: true });
});

test('cross-session isolation: no contamination', async () => {
  const { db, dir } = freshDb();
  const { llmMod, embedFn, cfg } = makeCtx(db);
  for (const sid of ['s1','s2']) {
    db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run(sid, '/p');
    db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, tool_name, tool_target, created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(sid==='s1'?2:3, sid, 'cp1', '/p', 'TOOL', 'Write', 'Write\x00/'+sid+'.js', '2026-09-03T00:00:00Z');
    db.prepare("INSERT INTO tool_details(prompt_id, tool_name, input_json, output_json, created_at) VALUES(?,?,?,?,?)")
      .run(sid==='s1'?2:3, 'Write', '{"path":"/'+sid+'.js"}', '{}', '2026-09-03T00:00:00Z');
  }
  const c = new Consumer({ db, loadCfg: cfg, embedFn, llmMod });
  c.start();
  c.push({ kind:'tool', sessionId:'s1', toolRowId:2, toolTarget:'Write\x00/s1.js' });
  c.push({ kind:'tool', sessionId:'s2', toolRowId:3, toolTarget:'Write\x00/s2.js' });
  c.push({ kind:'result', sessionId:'s1', promptRowId:1 });  // s1 flush; s2 仍 open
  await sleep(150);
  c.stop();
  assert.ok(db.prepare("SELECT summary_meta FROM prompts WHERE id=2").get().summary_meta, 's1 已 flush');
  fs.rmSync(dir, { recursive: true });
});
```

- [x] **Step 2: 跑测试确认失败**

`npm test -- test/queue.test.js 2>&1 | tail -5` → FAIL（`lib/queue.js` 不存在）。

- [x] **Step 3: 实现 lib/queue.js**

```js
// lib/queue.js — cw-mem 进程内内存队列 + 流式工具聚合。
// 单进程单消费者: 全局 FIFO + per-session Lane 串行 + per-session Accumulator 累积。
// 纯 DB 写由 server 同步完成, 这里只调度 LLM 工作(tool/result/session 摘要)。

const { runToolGroupSummary, runStopBatch, runSessionSummary, runVectorRetry, findSessionsNeedingSummary } = require('./batch');
const llmMod = require('./llm');

class Queue {
  #items = [];
  push(it) { this.#items.push(it); }
  take() { return this.#items.shift(); }
  get size() { return this.#items.length; }
  peekOldestAge() { const h = this.#items[0]; return h && h._enq ? Date.now() - h._enq : 0; }
}

class Lane {                               // per-session 串行链: 同 session 严格 FIFO
  #chain = Promise.resolve();
  run(fn) {
    const r = this.#chain.then(() => fn(), () => fn());   // 无论上一条 resolve/reject 都跑 fn
    this.#chain = r.then(() => {}, () => {});              // 链本身永不 reject
    return r.then(() => {}, () => {});                     // 返回也永不 reject: 只串行化, 吞掉 fn 的 rejection, 不让 #loop 死
  }
}

class Accumulator {
  group = null;                            // { toolTarget, toolName, ids: [] }
  timer = null;
}

class Consumer {
  #queue = new Queue();
  #lanes = new Map();
  #accs = new Map();
  #idle = true;
  #idleTimer = null;
  #running = false;
  #db; #loadCfg; #embedFn; #llmMod;

  constructor({ db, loadCfg, embedFn, llmMod }) {
    this.#db = db; this.#loadCfg = loadCfg; this.#embedFn = embedFn;
    this.#llmMod = llmMod || llmMod;       // 默认用 lib/llm
  }

  cfg() { return this.#loadCfg(); }

  #lane(sid) { if (!this.#lanes.has(sid)) this.#lanes.set(sid, new Lane()); return this.#lanes.get(sid); }
  #acc(sid)  { if (!this.#accs.has(sid))  this.#accs.set(sid, new Accumulator()); return this.#accs.get(sid); }

  start() { this.#running = true; this.#wake(); }
  stop() { this.#running = false; clearTimeout(this.#idleTimer); for (const a of this.#accs.values()) clearTimeout(a.timer); }

  push(item) { item._enq = Date.now(); this.#queue.push(item); if (this.#idle && this.#running) this.#wake(); }

  #wake() { clearTimeout(this.#idleTimer); this.#idle = false; setImmediate(() => this.#loop()); }

  async #loop() {
    if (!this.#running) return;
    for (;;) {
      const item = this.#queue.take();
      if (!item) { this.#idle = true; this.#idleTimer = setTimeout(() => this.#loop(), this.cfg().queue.pollMs); this.#idleTimer.unref(); return; }
      await this.#lane(item.sessionId).run(() => this.#handle(item));
    }
  }

  async #handle(item) {
    if (item.kind === 'flush')     return this.#flush(item.sessionId);
    if (item.kind === 'result')    { await this.#flush(item.sessionId); return this.#runResult(item); }
    if (item.kind === 'session')   { await this.#flush(item.sessionId); return this.#runSession(item); }
    if (item.kind === 'toolgroup') return this.#summarizeGroup(item.sessionId,
        { toolTarget:'', toolName: item.toolName, ids: item.toolRowIds }, item.attempts || 0);

    if (item.kind !== 'tool') return;
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
    const closed = acc.group;
    acc.group = null;                       // 先摘出, 避免 #summarizeGroup 内部意外异常后旧组残留
    await this.#summarizeGroup(item.sessionId, closed, 0);
    acc.group = { toolTarget: item.toolTarget, toolName: item.toolName, ids: [item.toolRowId] };
    return this.#arm(item.sessionId);
  }

  #arm(sid) {
    const acc = this.#acc(sid);
    clearTimeout(acc.timer);
    acc.timer = setTimeout(() => this.push({ kind:'flush', sessionId: sid }),
                           this.cfg().queue.quiescenceSeconds * 1000);
    acc.timer.unref();
  }

  async #flush(sid) {
    const acc = this.#acc(sid);
    clearTimeout(acc.timer);
    if (!acc.group) return;
    const g = acc.group; acc.group = null;
    await this.#summarizeGroup(sid, g, 0);
  }

  // 契约: runToolGroupSummary 对 LLM 失败返回 {status:'failed', retryable}, 不抛;
  // 仅意外异常抛, 在此 catch 兜底退避。重试靠重新入队 toolgroup, 不阻塞 lane。
  async #summarizeGroup(sid, g, attempts) {
    const cfg = this.cfg();
    let r;
    try { r = await runToolGroupSummary({ db: this.#db, cfg, toolRowIds: g.ids, toolName: g.toolName, llmMod: this.#llmMod, embedFn: this.#embedFn }); }
    catch (e) {
      if (attempts < cfg.llm.maxRetries) this.#scheduleRetry('toolgroup', sid, g, attempts);
      return;
    }
    if (r.status === 'failed' && r.retryable && attempts < cfg.llm.maxRetries) this.#scheduleRetry('toolgroup', sid, g, attempts);
  }

  #scheduleRetry(kind, sid, g, attempts) {
    const cfg = this.cfg();
    const ms = Math.min((cfg.llm.retryIntervalSeconds || 1) * 2 ** attempts, 600) * 1000;
    const t = setTimeout(() => this.push({ kind, sessionId: sid, toolRowIds: g.ids, toolName: g.toolName, attempts: attempts + 1 }), ms);
    t.unref();
  }

  async #runResult(item) {
    const cfg = this.cfg();
    const r = await runStopBatch({ db: this.#db, cfg, promptRowId: item.promptRowId, llmMod: this.#llmMod, embedFn: this.#embedFn });
    if (r.status === 'failed') {
      const st = this.#db.prepare('SELECT summary_status FROM prompts WHERE id=?').get(item.promptRowId);
      if (st && st.summary_status === 'failed_pending_retry') {
        const n = this.#db.prepare('SELECT COALESCE(retry_attempts,0) n FROM prompts WHERE id=?').get(item.promptRowId).n;
        if (n < cfg.llm.maxRetries) {
          const ms = Math.min((cfg.llm.retryIntervalSeconds || 1) * 2 ** n, 600) * 1000;
          const t = setTimeout(() => this.push({ kind:'result', sessionId: item.sessionId, promptRowId: item.promptRowId }), ms);
          t.unref();
        }
      }
    }
  }

  async #runSession(item) {
    const cfg = this.cfg();
    const r = await runSessionSummary({ db: this.#db, cfg, sessionId: item.sessionId, llmMod: this.#llmMod, embedFn: this.#embedFn });
    if (r.status === 'skipped' && (item.attempts || 0) < cfg.llm.maxRetries) {
      const ms = Math.min((cfg.llm.retryIntervalSeconds || 1) * 2 ** (item.attempts || 0), 600) * 1000;
      const t = setTimeout(() => this.push({ kind:'session', sessionId: item.sessionId, attempts: (item.attempts || 0) + 1 }), ms);
      t.unref();
    }
  }

  // 启动恢复: 见 Task 6
  recover() { /* Task 6 实现 */ }
  drainSpool() { /* Task 6 实现 */ }
  vectorSweep() { /* Task 6 实现 */ }
}

module.exports = { Consumer, Queue, Lane, Accumulator };
```

- [x] **Step 4: 跑测试确认通过**

`npm test -- test/queue.test.js` → 4 个用例 PASS。

- [x] **Step 5: commit**

`git add lib/queue.js test/queue.test.js && git commit -m "feat(queue): Consumer + 流式聚合 handle/flush/summarizeGroup"`

---

## Task 6: queue.js — recover() + drainSpool() + vectorSweep() + 静默兜底

**Files:**
- Modify: `lib/queue.js`（补 `recover`/`drainSpool`/`vectorSweep`）
- Test: `test/queue.test.js`

**Interfaces:**
- Consumes: `findSessionsNeedingSummary`、`runVectorRetry`、server 传入的 `handlers` map（path → fn）供 drainSpool 复用
- Produces: `Consumer.recover()`、`Consumer.drainSpool(handlers)`、`Consumer.vectorSweep()`、`Consumer.startSweepTimer()`

- [x] **Step 1: 写失败测试**

追加到 `test/queue.test.js`：

```js
test('recover rebuilds toolgroup/result/session items from DB state', async () => {
  const { db, dir } = freshDb();
  const { llmMod, embedFn, cfg } = makeCtx(db);
  db.prepare("INSERT INTO sessions(id, project_dir, ended_at) VALUES(?,?,?)").run('s1', '/p', '2026-09-03T00:00:00Z');
  // 未摘要的 TOOL 行
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, tool_name, tool_target, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(2, 's1', 'cp1', '/p', 'TOOL', 'Write', 'Write\x00/a.js', '2026-09-03T00:00:00Z');
  db.prepare("INSERT INTO tool_details(prompt_id, tool_name, input_json, output_json, created_at) VALUES(?,?,?,?,?)")
    .run(2, 'Write', '{"path":"/a.js"}', '{}', '2026-09-03T00:00:00Z');
  // 待摘要的 PROMPT 行
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, prompt, response, summary_status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(1, 's1', 'cp1', '/p', 'PROMPT', 'r', 'resp', 'pending', '2026-09-03T00:00:00Z');
  // session 摘要缺失(无 session_summaries 行)
  const c = new Consumer({ db, loadCfg: cfg, embedFn, llmMod });
  const pushed = [];
  const orig = c.push.bind(c); c.push = (it) => { pushed.push(it); };
  c.recover();
  const kinds = pushed.map(p => p.kind).sort();
  assert.ok(kinds.includes('toolgroup'), 'recover 重建 toolgroup');
  assert.ok(kinds.includes('result'), 'recover 重建 result');
  assert.ok(kinds.includes('session'), 'recover 重建 session');
  fs.rmSync(dir, { recursive: true });
});

test('recover picks up failed_pending_retry TOOL rows', async () => {
  const { db, dir } = freshDb();
  const { llmMod, embedFn, cfg } = makeCtx(db);
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, tool_name, tool_target, summary_status, retry_attempts, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(2, 's1', 'cp1', '/p', 'TOOL', 'Write', 'Write\x00/a.js', 'failed_pending_retry', 1, '2026-09-03T00:00:00Z');
  const c = new Consumer({ db, loadCfg: cfg, embedFn, llmMod });
  const pushed = []; c.push = (it) => pushed.push(it);
  c.recover();
  assert.ok(pushed.some(p => p.kind === 'toolgroup' && p.toolRowIds.includes(2)), 'failed_pending_retry TOOL 行被重建');
  fs.rmSync(dir, { recursive: true });
});

test('drainSpool applies spooled items and deletes the file', async () => {
  const { db, dir } = freshDb();
  const { llmMod, embedFn, cfg } = makeCtx(db);
  // 手写一个 spool 文件: 模拟一次 /api/sessions POST
  fs.mkdirSync(path.join(dir, 'spool'));
  fs.writeFileSync(path.join(dir, 'spool', '1700000000000-123.jsonl'),
    JSON.stringify({ path:'/api/sessions', body:{ sessionId:'sX', projectDir:'/p' } }) + '\n');
  const c = new Consumer({ db, loadCfg: cfg, embedFn, llmMod });
  const handlers = { '/api/sessions': (body) => db.prepare('INSERT OR IGNORE INTO sessions(id, project_dir, started_at, last_seen_at) VALUES(?,?,?,?)').run(body.sessionId, body.projectDir, 't', 't') };
  c.drainSpool(dir, handlers);
  assert.ok(db.prepare("SELECT id FROM sessions WHERE id='sX'").get(), 'spooled session 已写入');
  assert.ok(!fs.existsSync(path.join(dir, 'spool', '1700000000000-123.jsonl')), 'spool 文件已删除');
  fs.rmSync(dir, { recursive: true });
});
```

- [x] **Step 2: 跑测试确认失败**

`npm test -- test/queue.test.js 2>&1 | tail -10` → 新用例 FAIL（`recover`/`drainSpool` 空实现）。

- [x] **Step 3: 实现 recover / drainSpool / vectorSweep / sweep timer**

在 `lib/queue.js` 的 `Consumer` 内替换 Task 5 的占位方法：

```js
  #sweepTimer = null;
  #vectorBusy = false;

  // 启动恢复 + spool 排空 + sweep 定时器。start() 之后由 server 调用。
  startFull(handlers, dataDir) {
    this.start();
    this.drainSpool(dataDir, handlers);
    this.recover();
    const sweepMs = this.cfg().queue.sweepIntervalSeconds * 1000;
    this.#sweepTimer = setInterval(() => { this.drainSpool(dataDir, handlers); this.vectorSweep(); }, sweepMs);
    this.#sweepTimer.unref();
  }

  recover() {
    const db = this.#db;
    const cfg = this.cfg();
    const maxAttempts = this.#llmMod.maxSummaryAttempts(cfg);
    // 1. 未完成摘要的 TOOL 行: '' / failed_pending_retry 未超限 / generating 超 180s
    const tools = db.prepare(`SELECT id, session_id, tool_target, tool_name, summary_status, retry_attempts
      FROM prompts WHERE type='TOOL' AND (
        summary_status = '' OR summary_status IS NULL
        OR (summary_status='failed_pending_retry' AND COALESCE(retry_attempts,0) < ?)
        OR (summary_status='generating' AND summary_updated_at IS NOT NULL
            AND summary_updated_at < datetime('now','-180 seconds'))
      ) ORDER BY id`).all(maxAttempts);
    const buckets = new Map();   // (sid|target) → { sid, target, name, ids }
    for (const r of tools) {
      const key = r.session_id + '|' + r.tool_target;
      if (!buckets.has(key)) buckets.set(key, { sessionId: r.session_id, toolTarget: r.tool_target, toolName: r.tool_name, ids: [] });
      buckets.get(key).ids.push(r.id);
    }
    const max = cfg.queue.toolGroupMax;
    for (const b of buckets.values()) {
      for (let i = 0; i < b.ids.length; i += max) {
        this.push({ kind:'toolgroup', sessionId: b.sessionId, toolRowIds: b.ids.slice(i, i+max), toolName: b.toolName, attempts: 0 });
      }
    }
    // 2. 待摘要的 PROMPT 行
    const prompts = db.prepare(`SELECT id, session_id FROM prompts
      WHERE type='PROMPT' AND COALESCE(response,'') <> '' AND COALESCE(summary,'') = '' AND (
        summary_status = 'pending'
        OR (summary_status='failed_pending_retry' AND COALESCE(retry_attempts,0) < ?)
        OR (summary_status='generating' AND summary_updated_at IS NOT NULL
            AND summary_updated_at < datetime('now','-180 seconds'))
      ) ORDER BY id`).all(maxAttempts);
    for (const p of prompts) this.push({ kind:'result', sessionId: p.session_id, promptRowId: p.id });
    // 3. session 摘要补齐
    for (const sid of findSessionsNeedingSummary(db, 50)) this.push({ kind:'session', sessionId: sid, attempts: 0 });
  }

  drainSpool(dataDir, handlers) {
    const spoolDir = path.join(dataDir, 'spool');
    if (!fs.existsSync(spoolDir)) return;
    for (const f of fs.readdirSync(spoolDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(spoolDir, f);
      try {
        const lines = fs.readFileSync(full, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          const { path: p, body } = JSON.parse(line);
          const h = handlers && handlers[p];
          if (h) h(body); else console.warn('[cw-mem] spool 无 handler: ' + p);
        }
        fs.unlinkSync(full);
      } catch (e) { console.warn('[cw-mem] spool 排空失败 ' + f + ': ' + e.message); }
    }
  }

  vectorSweep() {
    if (this.#vectorBusy) return;
    this.#vectorBusy = true;
    runVectorRetry({ db: this.#db, cfg: this.cfg(), embedFn: this.#embedFn, limit: 20 })
      .catch(e => console.warn('[cw-mem] 向量补齐异常: ' + (e && e.message)))
      .finally(() => { this.#vectorBusy = false; });
  }
```

文件顶部 `require('node:fs')` 和 `require('node:path')`：

```js
const fs = require('node:fs');
const path = require('node:path');
```

`stop()` 里加 `clearTimeout(this.#sweepTimer)`。

- [x] **Step 4: 跑测试确认通过**

`npm test -- test/queue.test.js` → 全绿。

- [x] **Step 5: commit**

`git add lib/queue.js test/queue.test.js && git commit -m "feat(queue): recover/drainSpool/vectorSweep + sweep 定时器"`

---

## Task 7: server.js — 接入队列

**Files:**
- Modify: `lib/server.js`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `Consumer`（queue.js）、`_truncateToBytes`（batch.js）
- Produces: 端点 `handleXxx` 函数（供 spool drain 复用）、`GET /api/queue`、启动时 `drain spool → recover → start consumer`。

- [x] **Step 1: 写失败测试**

追加到 `test/server.test.js`：

```js
test('POST /api/tool-details enqueues a tool item', async () => { await boot(); try {
  await req('POST','/api/sessions', { sessionId:'s1', projectDir:'/p' });
  const pj = JSON.parse((await req('POST','/api/prompts', { sessionId:'s1', prompt:'Write: a.js', type:'TOOL', toolName:'Write', claudePromptId:'cp1', projectDir:'/p', filePath:'/a.js' })).body);
  assert.ok(pj.id > 0);
  const tj = JSON.parse((await req('POST','/api/tool-details', { promptId: pj.id, sessionId:'s1', filePath:'/a.js', toolInput:{path:'/a.js'}, toolOutput:{ok:true}, toolName:'Write' })).body);
  assert.equal(tj.status, 'ok');
  const q = JSON.parse((await req('GET','/api/queue')).body);
  assert.ok(q.queued >= 1, '队列应有 1 个 tool item');
} finally { serverHandle.close(); fs.rmSync(dir,{recursive:true}); } });

test('POST /api/prompts/summarize returns queued', async () => { await boot(); try {
  await req('POST','/api/sessions', { sessionId:'s1', projectDir:'/p' });
  const pj = JSON.parse((await req('POST','/api/prompts', { sessionId:'s1', prompt:'hi', type:'PROMPT', claudePromptId:'cp1', projectDir:'/p' })).body);
  await req('POST','/api/prompts/response', { promptId:'cp1', sessionId:'s1', response:'resp' });
  const j = JSON.parse((await req('POST','/api/prompts/summarize', { sessionId:'s1', promptId:'cp1' })).body);
  assert.equal(j.status, 'ok');
  assert.equal(j.queued, true);
} finally { serverHandle.close(); fs.rmSync(dir,{recursive:true}); } });
```

- [x] **Step 2: 跑测试确认失败**

`npm test -- test/server.test.js 2>&1 | tail -10` → FAIL（`/api/queue` 不存在）。

- [x] **Step 3: 实现 — 抽取 handleXxx + 端点改 push**

在 `lib/server.js` 顶部 require：

```js
const { Consumer } = require('./queue');
const { _truncateToBytes } = require('./batch');
```

在 `startServer` 内，`state` 加 `consumer: null`。定义 handle 函数（放在路由之前，闭包内能访问 `db`/`cfg`/`embedFn`）：

```js
    // 端点核心逻辑: 端点本身和 spool drain 都调它, 避免逻辑分叉
    function handleToolDetails(data) {
      const inputJson = data.toolInput != null ? JSON.stringify(data.toolInput) : null;
      const outputJson = data.toolOutput != null ? JSON.stringify(data.toolOutput) : null;
      const max = reloadCfg().toolSummary.payloadMaxBytes;
      const r = db.prepare(
        'INSERT INTO tool_details (prompt_id, input_json, output_json, tool_use_id, tool_name, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(data.promptId, truncBytes(inputJson, max), truncBytes(outputJson, max), data.toolUseId || null, data.toolName || null, data.durationMs != null ? String(data.durationMs) : null, nowIso());
      // push tool item 到队列(tool_target 在 /api/prompts 时已写)
      const row = db.prepare('SELECT tool_target, tool_name, session_id FROM prompts WHERE id=?').get(data.promptId);
      if (row && state.consumer) state.consumer.push({ kind:'tool', sessionId: row.session_id, toolRowId: data.promptId, toolTarget: row.tool_target || ((row.tool_name||'') + '\x00') });
      return { status:'ok', id: r.lastInsertRowid };
    }
    function truncBytes(s, max) { return max > 0 ? _truncateToBytes(s, max) : s; }
    function handleResponse(data) {
      if (!data.promptId || !data.response) return { status:'skipped' };
      const r = db.prepare("UPDATE prompts SET response = ? WHERE claude_prompt_id = ? AND session_id = ? AND type = 'PROMPT'").run(data.response, data.promptId, data.sessionId);
      return { status:'ok', changes: r.changes };
    }
    function handleSummarize(data) {
      const row = db.prepare("SELECT * FROM prompts WHERE claude_prompt_id = ? AND session_id = ? AND type = 'PROMPT' AND COALESCE(response,'') <> ''").get(data.promptId, data.sessionId);
      if (!row) return { status:'skipped' };
      const s = row.summary_status || '';
      if (s === 'success' || s === 'generating') return { status:'skipped', reason: s };
      if ((row.retry_attempts || 0) >= llm.maxSummaryAttempts(reloadCfg())) return { status:'skipped', reason:'max_retries_reached' };
      llm.setSummaryStatus(db, row.id, 'pending');
      if (state.consumer) state.consumer.push({ kind:'result', sessionId: data.sessionId, promptRowId: row.id });
      return { status:'ok', queued:true, id: row.id };
    }
    function handleSessionSummarize(data) {
      if (!data.sessionId) return { status:'skipped' };
      db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run(nowIso(), data.sessionId);
      if (state.consumer) state.consumer.push({ kind:'session', sessionId: data.sessionId, attempts: 0 });
      return { status:'ok', queued:true, sessionId: data.sessionId };
    }
    const SPOOL_HANDLERS = {
      '/api/tool-details': handleToolDetails,
      '/api/prompts/response': handleResponse,
      '/api/prompts/summarize': handleSummarize,
      '/api/sessions/summarize': handleSessionSummarize
    };
```

路由里：
- `/api/tool-details` POST → `return json(res, handleToolDetails(data))`
- `/api/prompts` POST（type=TOOL）→ 在现有 INSERT 的列里多写 `tool_target`：构造 `(data.toolName || '') + ' ' + (data.filePath || '')` 一并插入（PROMPT 行不写、留 NULL）
- `/api/prompts/response` POST → 不变（仍直接写），但保留
- `/api/prompts/summarize` POST → `return json(res, handleSummarize(data))`（删除 `server.js:325` 的直接 `runStopBatch`）
- `/api/sessions/summarize` POST → `return json(res, handleSessionSummarize(data))`（删除 `server.js:427` 的直接 `runSessionSummary`）
- `/api/prompts/summarize-retry` POST → 重置 `retry_attempts` 后 `state.consumer.push({kind:'result', ...})`
- `/api/prompts/tool-summary` → **删除整段**（`server.js:381-390`）
- 新增 `/api/queue` GET：

```js
        if (pathname === '/api/queue' && req.method === 'GET') {
          return json(res, { queued: state.consumer ? state.consumer.queueDepth() : 0, openGroups: state.consumer ? state.consumer.openGroupCount() : 0 });
        }
```

（在 `Consumer` 加 `queueDepth()` 和 `openGroupCount()` 方法，返回 `this.#queue.size` 与 `this.#accs` 中非 null group 数。）

- [x] **Step 4: 实现 — 删除 retry round + 启动序列**

删除 `runSummaryRetryRound`、`runSessionSummaryRound`、`runVectorRetryRound`、`startSummaryRetryTimer`、`state.summaryBusy/vectorBusy/sessionSummaryBusy`、`state.summaryRetryTimer`，以及 `server.on('close')` 里对 `summaryRetryTimer` 的清理。`server.listen` 回调里把 `startSummaryRetryTimer()` 换成：

```js
      state.consumer = new Consumer({ db, loadCfg: () => reloadCfg(), embedFn, llmMod: llm });
      state.consumer.startFull(SPOOL_HANDLERS, dataDir);   // drain spool → recover → start + sweep
```

`POST /api/config` 的 `toolSummary` 分支加：

```js
                if (typeof data.toolSummary.payloadMaxBytes === 'number') cfg.toolSummary.payloadMaxBytes = data.toolSummary.payloadMaxBytes;
```

并新增 `queue` 分支：

```js
              if (data.queue) {
                if (typeof data.queue.pollMs === 'number') cfg.queue.pollMs = data.queue.pollMs;
                if (typeof data.queue.quiescenceSeconds === 'number') cfg.queue.quiescenceSeconds = data.queue.quiescenceSeconds;
                if (typeof data.queue.toolGroupMax === 'number') cfg.queue.toolGroupMax = data.queue.toolGroupMax;
                if (typeof data.queue.sweepIntervalSeconds === 'number') cfg.queue.sweepIntervalSeconds = data.queue.sweepIntervalSeconds;
                if (data.queue.spool && typeof data.queue.spool.enabled === 'boolean') cfg.queue.spool.enabled = data.queue.spool.enabled;
              }
```

`needRestart` 不变（这些项都即时生效）。

- [x] **Step 5: 跑测试确认通过**

`npm test -- test/server.test.js` → PASS。

- [x] **Step 6: commit**

`git add lib/server.js lib/queue.js test/server.test.js && git commit -m "feat(server): 端点改入队 + handleXxx + 启动 drain→recover→start + GET /api/queue"`

---

## Task 8: hooks — _spool.sh + _ensure_server.sh + 各 hook source

**Files:**
- Create: `hooks-handlers/_spool.sh`
- Create: `hooks-handlers/_ensure_server.sh`
- Modify: `hooks-handlers/post-tool-use.sh`、`stop.sh`、`user-prompt-submit.sh`、`session-end.sh`、`session-start.sh`

**Interfaces:**
- Consumes: server 端点（Task 7）
- Produces: hook 失败时写本地 spool；server 不可达时 lazy-start。

- [x] **Step 1: 写 _spool.sh**

```bash
# hooks-handlers/_spool.sh — hook 连不上 server 时的本地兜底(仅 queue.spool.enabled=true 时生效)
# 各 hook source 此文件后, 在 post 失败分支调 spool <path> <json-body>。
spool() {                                     # spool <path> <json-body>
  local CFG="$CW_MEM_DATA_DIR/config.json"
  # config 不可读/malformed 时 fail-safe = 不 spool(丢弃, 与现状一致), 切不可吞错反而 spool
  [ -f "$CFG" ] && node -e "try{if(JSON.parse(require('fs').readFileSync(process.env.CFG||process.argv[1],'utf8')).queue?.spool?.enabled!==true)process.exit(1)}catch(e){process.exit(1)}" "$CFG" || return 1
  mkdir -p "$CW_MEM_DATA_DIR/spool"
  local F="$CW_MEM_DATA_DIR/spool/$(date +%s%3N)-$$.jsonl"
  node -e "require('fs').appendFileSync(process.env.F, JSON.stringify({path:process.argv[1], body:JSON.parse(process.argv[2])})+'\n')" "$1" "$2"
}
export -f spool
```

- [x] **Step 2: 写 _ensure_server.sh**

把 `session-start.sh` 里现有的 lazy-start 块（`if ! curl ... /api/health` 那段）抽出：

```bash
# hooks-handlers/_ensure_server.sh — 确保 server 运行; 若 spool 目录非空则强制拉起(自举缺口兜底)
# 用法: ensure_server [max_wait_seconds]
ensure_server() {
  local MAX="${1:-5}"
  if curl -s --max-time 1 "$SERVER_URL/api/health" > /dev/null 2>&1; then return 0; fi
  # spool 非空 → 必须拉起(server 是唯一排空者)
  if [ -d "$CW_MEM_DATA_DIR/spool" ] && [ "$(ls -A "$CW_MEM_DATA_DIR/spool" 2>/dev/null)" ]; then
    : # 强制拉起
  fi
  log_info "server not running, starting..."
  nohup node "$SERVER_JS" "$CW_MEM_DATA_DIR" "$PLUGIN_UI_DIR" > "$CW_MEM_DATA_DIR/server.log" 2>&1 &
  for i in $(seq 1 $((MAX * 2))); do
    if curl -s --max-time 1 "$SERVER_URL/api/health" > /dev/null 2>&1; then log_info "server started"; return 0; fi
    sleep 0.5
  done
  log_warn "server failed to start within ${MAX}s"
  return 1
}
export -f ensure_server
```

- [x] **Step 3: 改 post-tool-use.sh**

在文件头部 `source _log.sh` 之后加：

```bash
source "$(dirname "$0")/_spool.sh"
source "$(dirname "$0")/_ensure_server.sh"
export SERVER_JS="$PLUGIN_ROOT/lib/server.js"
export PLUGIN_UI_DIR="$PLUGIN_ROOT/ui"
```

在 `post` 失败分支（`if (!sessR.ok)` 等）调 `spool`。具体：把 `const sessR = await post('/api/sessions', {...})` 等失败的分支改为先 `ensure_server 3` 再试，仍失败则 `spool '/api/sessions' "$(printf '%s' '{...}')`。`/api/prompts` 的 body 加 `filePath: data.tool_input?.file_path || ''`；`/api/tool-details` 的 body 加 `sessionId: session_id` + `filePath`。

- [x] **Step 4: 改其余 hook**

`stop.sh` / `user-prompt-submit.sh` / `session-end.sh` 头部加 `source _spool.sh` + `source _ensure_server.sh` + `export SERVER_JS/PLUGIN_UI_DIR`。`session-start.sh` 删掉内联 lazy-start 块，改为 `source _ensure_server.sh` + `ensure_server 5`。

- [x] **Step 5: 语法检查 + 手测**

```bash
bash -n hooks-handlers/_spool.sh hooks-handlers/_ensure_server.sh hooks-handlers/post-tool-use.sh hooks-handlers/stop.sh hooks-handlers/user-prompt-submit.sh hooks-handlers/session-end.sh hooks-handlers/session-start.sh
```

期望：无语法错误。

- [x] **Step 6: commit**

`git add hooks-handlers/ && git commit -m "feat(hooks): _spool.sh + _ensure_server.sh + 各 hook 接入 spool/lazy-start"`

---

## Task 9: ui — 队列分组 + payloadMaxBytes 字段

**Files:**
- Modify: `ui/index.html`

**Interfaces:**
- Consumes: Task 1 的配置项、Task 7 的 `GET /api/queue`
- Produces: UI 设置面板「队列」分组 + payload 上限字段。

- [x] **Step 1: 加面板 HTML**

在 `tab-recall` 内「工具调用摘要」`.sg` 之后加新分组：

```html
        <div class="sg">
          <div class="sg-title">队列</div>
          <div class="field">
            <label>空队列轮询间隔(ms) <span class="reboot-tag reboot-no">即时生效</span></label>
            <div class="field-input"><input type="number" id="sQueuePollMs" min="50" max="5000"></div>
            <div class="help">只影响"从空到有"的响应延迟, 不影响处理速度</div>
          </div>
          <div class="field">
            <label>静默兜底时长(秒) <span class="reboot-tag reboot-no">即时生效</span></label>
            <div class="field-input"><input type="number" id="sQuiescenceSeconds" min="5" max="600"></div>
            <div class="help">该会话无新工具到达多久后强制 flush 打开的组; 正常 Stop 到达即 flush, 仅在 Stop 丢失时生效</div>
          </div>
          <div class="field">
            <label>单组聚合上限 <span class="reboot-tag reboot-no">即时生效</span></label>
            <div class="field-input"><input type="number" id="sToolGroupMax" min="1" max="20"></div>
          </div>
          <div class="field">
            <label>向量补齐周期(秒) <span class="reboot-tag reboot-no">即时生效</span></label>
            <div class="field-input"><input type="number" id="sSweepIntervalSeconds" min="10" max="3600"></div>
          </div>
          <div class="field">
            <label>启用本地 spool 兜底 <span class="reboot-tag reboot-no">即时生效</span></label>
            <label class="toggle"><input type="checkbox" id="sQueueSpool"><span class="track"></span></label>
            <div class="help">hook 连不上 server 时写本地 spool, server 启动/周期排空; 关闭则失败即丢弃(现状行为)</div>
          </div>
        </div>
```

在「工具调用摘要」分组末尾加：

```html
          <div class="field">
            <label>工具 I/O 上限(字节) <span class="reboot-tag reboot-no">即时生效</span></label>
            <div class="field-input"><input type="number" id="sPayloadMaxBytes" min="0" max="10485760"></div>
            <div class="help">0 = 不截断; 否则头尾各半保留。防止单次大输出撑爆 cw-mem.db</div>
          </div>
```

- [x] **Step 2: populateUI 填充**

在 `populateUI`（约 636 行）末尾加：

```js
  document.getElementById('sQueuePollMs').value = cfg.queue.pollMs;
  document.getElementById('sQuiescenceSeconds').value = cfg.queue.quiescenceSeconds;
  document.getElementById('sToolGroupMax').value = cfg.queue.toolGroupMax;
  document.getElementById('sSweepIntervalSeconds').value = cfg.queue.sweepIntervalSeconds;
  document.getElementById('sQueueSpool').checked = cfg.queue.spool.enabled;
  document.getElementById('sPayloadMaxBytes').value = cfg.toolSummary.payloadMaxBytes;
```

- [x] **Step 3: buildPayload 收集**

在 `buildPayload`（约 654 行）的 `toolSummary:` 改为：

```js
    toolSummary: {
      enabled: document.getElementById('sToolSummaryEnabled').checked,
      skipMode: document.getElementById('sSkipMode').value,
      payloadMaxBytes: parseInt(document.getElementById('sPayloadMaxBytes').value, 10)
    },
    queue: {
      pollMs: parseInt(document.getElementById('sQueuePollMs').value, 10),
      quiescenceSeconds: parseInt(document.getElementById('sQuiescenceSeconds').value, 10),
      toolGroupMax: parseInt(document.getElementById('sToolGroupMax').value, 10),
      sweepIntervalSeconds: parseInt(document.getElementById('sSweepIntervalSeconds').value, 10),
      spool: { enabled: document.getElementById('sQueueSpool').checked }
    },
```

`saveConfig` 的 `needRestart` 判断不改（这些项都即时生效）。

- [x] **Step 4: 手测**

`node lib/server.js /tmp/cw-mem-ui ui/ 37890 &` → 浏览器打开 → 设置面板出现「队列」分组 + payload 字段，改值保存后 `cat /tmp/cw-mem-ui/config.json` 确认落盘。

- [x] **Step 5: commit**

`git add ui/index.html && git commit -m "feat(ui): 队列分组 + payloadMaxBytes 字段"`

---

## Task 10: 端到端集成测试

**Files:**
- Test: `test/queue.test.js`

**Interfaces:**
- Consumes: Task 5/6 的 Consumer、Task 3/4 的 batch.js、fake LLM/embed

- [x] **Step 1: 写集成测试**

追加到 `test/queue.test.js`：

```js
test('end-to-end: tool items → flush → result → session', async () => {
  const { db, dir } = freshDb();
  const { llmMod, embedFn, cfg } = makeCtx(db);
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1', '/p');
  db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, prompt, response, created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(1, 's1', 'cp1', '/p', 'PROMPT', '做某事', 'final resp', '2026-09-03T00:00:00Z');
  for (const [id, fp] of [[2,'/a.js'],[3,'/a.js'],[4,'/b.js']]) {
    db.prepare("INSERT INTO prompts(id, session_id, claude_prompt_id, project_dir, type, tool_name, tool_target, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, 's1', 'cp1', '/p', 'TOOL', 'Write', 'Write\x00'+fp, '2026-09-03T00:00:0'+id+'Z');
    db.prepare("INSERT INTO tool_details(prompt_id, tool_name, input_json, output_json, created_at) VALUES(?,?,?,?,?)")
      .run(id, 'Write', '{"path":"'+fp+'"}', '{}', '2026-09-03T00:00:0'+id+'Z');
  }
  const c = new Consumer({ db, loadCfg: cfg, embedFn, llmMod });
  c.start();
  c.push({ kind:'tool', sessionId:'s1', toolRowId:2, toolTarget:'Write\x00/a.js' });
  c.push({ kind:'tool', sessionId:'s1', toolRowId:3, toolTarget:'Write\x00/a.js' });
  c.push({ kind:'tool', sessionId:'s1', toolRowId:4, toolTarget:'Write\x00/b.js' });
  c.push({ kind:'result', sessionId:'s1', promptRowId:1 });
  db.prepare("UPDATE sessions SET ended_at=? WHERE id=?").run('2026-09-03T00:00:10Z', 's1');
  c.push({ kind:'session', sessionId:'s1' });
  await sleep(300);
  c.stop();
  // result 摘要完成 + 引用了 tool 观察
  const p = db.prepare("SELECT summary_status, summary_meta FROM prompts WHERE id=1").get();
  assert.equal(p.summary_status, 'success');
  assert.ok(p.summary_meta && p.summary_meta.includes('批量改'), 'result 摘要引用了 tool 观察');
  fs.rmSync(dir, { recursive: true });
});
```

- [x] **Step 2: 跑测试确认通过**

`npm test -- test/queue.test.js` → PASS。

- [x] **Step 3: 跑全套**

`npm test` → 全绿（42+ 用例，含原有 + 新增）。

- [x] **Step 4: commit**

`git add test/queue.test.js && git commit -m "test(queue): 端到端集成 tool→result→session"`

---

## Self-Review

**1. Spec coverage** — 逐节核对：

| Spec 节 | 覆盖任务 |
|---|---|
| §2 决策 D1-D7 | D1/D2/D5→Task 5; D3→Task 7(handleXxx); D4→Task 5(复合键); D6→Task 4+5(重试); D7→Task 1+9 |
| §3 架构 | Task 5+7 |
| §4 数据结构 | Task 5 |
| §5 item kinds | Task 5+6 |
| §6 入队点 | Task 7 |
| §7 hook 改造 | Task 8 |
| §8 消费循环 + 5 flush + 顺序 + 定时器 unref | Task 5（`#wake` clearTimeout、Lane 吞 rejection、`.unref()`） |
| §9 batch.js 改动 | Task 3+4 |
| §10 重试分层 | Task 4（invalid json 统一）+ Task 5（#summarizeGroup 契约、退避）+ Task 6（recover 扫 failed_pending_retry） |
| §11 recover | Task 6 |
| §12 spool | Task 6（drainSpool）+ Task 8（_spool.sh）+ Task 7（启动顺序） |
| §13 payloadMaxBytes | Task 3（_truncateToBytes）+ Task 7（handleToolDetails）+ Task 9（UI） |
| §14 配置项 | Task 1+9 |
| §15 文件清单 | 全覆盖 |
| §16 测试 | Task 5+6+10 |
| §17 假设/限制 | 已在 spec, 无需任务 |
| §18 非目标 | 无需任务 |

无 gap。

**2. Placeholder scan** — 计划中无 TBD/TODO；Task 2 Step 3 的 `updSelf` 占位已显式标注"实现时删除，只留 bulk UPDATE"。

**3. Type consistency** — `runToolGroupSummary({db,cfg,toolRowIds,llmMod,embedFn})` → `{status, retryable}` 在 Task 3 定义、Task 5 消费，签名一致。`Consumer` 构造 `{db, loadCfg, embedFn, llmMod}` 在 Task 5 定义、Task 7 消费，一致。`push(item)` item 形状在 Task 5 定义、Task 7/6 消费，一致。`handleXxx(data)` 在 Task 7 定义、Task 6 `drainSpool` 经 `SPOOL_HANDLERS` 消费，一致。`_truncateToBytes(s, maxBytes)` Task 3 定义导出、Task 7 导入，一致。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-07-cw-mem-queue.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

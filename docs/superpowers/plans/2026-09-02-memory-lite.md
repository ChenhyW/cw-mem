# memory-lite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a lightweight Claude Code persistent-memory plugin that records prompts/tool-calls/results, summarizes them (LLM), vectorizes summaries (ollama), and recalls+injects relevant memory at session start and per prompt.

**Architecture:** Single-node: bash hooks → lazy-started node HTTP server → better-sqlite3 + sqlite-vec + ollama + LLM. "Lightweight observer" = batched review at Stop/SessionEnd (no parallel LLM session). Closed loop never breaks: result/session summaries and both injection points are mandatory; only tool-summary is toggleable.

**Tech Stack:** Node.js (built-in `http`, `node:test`), better-sqlite3, sqlite-vec, ollama (`/api/embed`), OpenAI-compatible/Anthropic LLM HTTP, bash hooks, vanilla HTML/JS UI.

**Spec:** `docs/superpowers/specs/2026-09-02-lightweight-memory-plugin-design.md`

## Global Constraints

- Data dir: `~/.memory-lite/` (`config.json`, `memory-lite.db`, logs). Env override `MEMORY_LITE_DATA_DIR`.
- Default server port: `37889` (avoid cw-mem's 37888).
- Tests run with `node --test` (built-in, zero-dep). Place tests under `test/` mirroring `lib/`.
- Embedding model default `nomic-embed-text` (dim 768); dim changes require rebuilding the `vec0` table → "needs restart".
- Hook stdin formats are verified facts (spec §2.1) — do not re-guess; parse exactly those fields.
- Injection uses `hookSpecificOutput.additionalContext` (model context), NOT `systemMessage`. `hookEventName` must match the event.
- Hooks are thin: POST to server and return immediately; all heavy work is server-side async. Hook stdout: `{"continue":true,"suppressOutput":true}` when not injecting; the JSON-with-`hookSpecificOutput` object when injecting.
- Mandatory (never make configurable): result summary (Stop), session summary (SessionEnd), SessionStart injection, UserPromptSubmit injection. Configurable: `toolSummary.enabled/skipMode`, recall numeric knobs.
- All config editable in UI (3 sections: 基础 / LLM与向量化 / 记忆与召回); buttons: 取消/保存/保存并重启; "needs restart" only for `server.port`/`ollama.url`/`ollama.embedModel`/`ollama.embedDim`.
- Prompts (3) are fixed code contracts, not user-editable.

## File Structure

```
.claude-plugin/plugin.json          # plugin metadata
.claude-plugin/marketplace.json    # marketplace manifest (plugins[].version drives updates)
hooks/hooks.json                    # register 5 hooks
hooks-handlers/_log.sh              # shared logging (port from cw-mem)
hooks-handlers/session-start.sh     # ensure server + SessionStart injection
hooks-handlers/user-prompt-submit.sh# record prompt + semantic recall+inject
hooks-handlers/post-tool-use.sh     # record raw tool I/O (only if toolSummary.enabled)
hooks-handlers/stop.sh              # write response + trigger batch summarize
hooks-handlers/session-end.sh       # trigger session summary
package.json                        # deps: better-sqlite3, sqlite-vec
lib/config.js                       # defaults, load, save, mergeLlm
lib/db.js                           # SQLite + sqlite-vec open/migrate, prepared stmts
lib/embed.js                        # ollama /api/embed client (batch + dim)
lib/llm.js                          # 3 prompt templates, validateObservation, summarize (provider), status machine helpers
lib/vector.js                       # write embedding + KNN + hybrid file recall
lib/recall.js                       # assemble injection text (sessionStart recency, userPrompt semantic)
lib/server.js                       # HTTP server + routes + static UI + lazy-start entrypoint
ui/index.html                       # history cards (linkage + injected_context) + 3-section config modal
test/config.test.js
test/db.test.js
test/embed.test.js
test/llm.test.js
test/vector.test.js
test/recall.test.js
```

---

### Task 1: Repo scaffold + manifests + hooks.json + package.json

**Files:**
- Create: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/hooks.json`, `hooks-handlers/_log.sh`, `.gitignore`

**Interfaces:**
- Produces: a runnable repo skeleton; `hooks/hooks.json` referencing 5 handler scripts (created later); `package.json` with deps.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "memory-lite",
  "version": "0.1.0",
  "description": "Lightweight persistent memory plugin for Claude Code",
  "main": "lib/server.js",
  "scripts": { "test": "node --test test/" },
  "dependencies": { "better-sqlite3": "^11.0.0", "sqlite-vec": "^0.1.6" }
}
```

- [ ] **Step 2: Create `.claude-plugin/plugin.json`**

```json
{ "name": "memory-lite", "version": "0.1.0", "author": { "name": "<owner>" }, "description": "轻量级持久化记忆插件" }
```

- [ ] **Step 3: Create `.claude-plugin/marketplace.json`**

```json
{
  "name": "memory-lite",
  "owner": { "name": "<owner>" },
  "metadata": { "description": "轻量级持久化记忆插件" },
  "plugins": [{ "name": "memory-lite", "version": "0.1.0", "source": ".", "description": "轻量级持久化记忆插件" }]
}
```

- [ ] **Step 4: Create `hooks/hooks.json`** (5 hooks; handler scripts created in later tasks)

```json
{
  "description": "memory-lite 持久化记忆",
  "hooks": {
    "SessionStart":     [{ "matcher": "*", "hooks": [{ "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks-handlers/session-start.sh",     "timeout": 10 }] }],
    "UserPromptSubmit": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks-handlers/user-prompt-submit.sh", "timeout": 10 }] }],
    "PostToolUse":      [{ "matcher": "*", "hooks": [{ "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks-handlers/post-tool-use.sh",      "timeout": 8 }] }],
    "Stop":             [{ "matcher": "*", "hooks": [{ "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks-handlers/stop.sh",              "timeout": 10 }] }],
    "SessionEnd":       [{ "matcher": "*", "hooks": [{ "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks-handlers/session-end.sh",        "timeout": 10 }] }]
  }
}
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules/
.memory-lite/
*.log
```

- [ ] **Step 6: Port `_log.sh` from cw-mem**

Copy `/Volumes/KINGSTON-CHENHY/plugins/cw-mem/hooks-handlers/_log.sh` to `hooks-handlers/_log.sh`; replace every `CW_MEM` → `MEMORY_LITE` and `cw-mem-` → `memory-lite-` (log file prefix). Keep behavior identical (level-resolved logging, daily rotation, truncation).

- [ ] **Step 7: Commit**

```bash
git add package.json .claude-plugin/ hooks/ hooks-handlers/_log.sh .gitignore
git commit -m "chore: scaffold memory-lite repo + manifests + hooks.json + log module"
```

---

### Task 2: `lib/config.js` — defaults, load, save, merge

**Files:**
- Create: `lib/config.js`, `test/config.test.js`

**Interfaces:**
- Produces: `DEFAULT_CONFIG` (object), `loadConfig(dataDir)`, `saveConfig(dataDir, cfg)`, `mergeLlm(base, input)`.

- [ ] **Step 1: Write failing test `test/config.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_CONFIG, loadConfig, saveConfig, mergeLlm } = require('../lib/config');

test('DEFAULT_CONFIG has 3 sections and mandatory defaults', () => {
  assert.equal(DEFAULT_CONFIG.server.port, 37889);
  assert.equal(DEFAULT_CONFIG.llm.enabled, false);
  assert.equal(DEFAULT_CONFIG.ollama.embedModel, 'nomic-embed-text');
  assert.equal(DEFAULT_CONFIG.ollama.embedDim, 768);
  assert.equal(DEFAULT_CONFIG.toolSummary.enabled, false);
  assert.equal(DEFAULT_CONFIG.toolSummary.skipMode, 'on');
  assert.equal(DEFAULT_CONFIG.recall.topK, 20);
  assert.equal(DEFAULT_CONFIG.recall.minScore, 0.30);
});

test('saveConfig then loadConfig round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-cfg-'));
  saveConfig(dir, { ...DEFAULT_CONFIG, server: { port: 39999 } });
  const loaded = loadConfig(dir);
  assert.equal(loaded.server.port, 39999);
  assert.equal(loaded.ollama.embedModel, 'nomic-embed-text');
});

test('mergeLlm keeps base apiKey when input omits it', () => {
  const base = { ...DEFAULT_CONFIG.llm, apiKey: 'sk-real' };
  const out = mergeLlm(base, { enabled: true });
  assert.equal(out.apiKey, 'sk-real');
  assert.equal(out.enabled, true);
});

test('mergeLlm rejects invalid provider', () => {
  const out = mergeLlm({ ...DEFAULT_CONFIG.llm }, { provider: 'gemini' });
  assert.equal(out.provider, 'openai-compatible');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/config.test.js`
Expected: FAIL (Cannot find module '../lib/config').

- [ ] **Step 3: Implement `lib/config.js`**

Port structure from cw-mem `ui/server.js` `DEFAULT_CONFIG`/`loadConfig`/`saveConfig`/`mergeLlm`, with memory-lite schema (spec §9): flat `server`/`log`/`llm`/`ollama`/`toolSummary`/`recall`. `mergeLlm` validates provider∈{openai-compatible,anthropic}, reasoningEffort∈{'',none,low,medium,high}, numeric clamps. `loadConfig(dataDir)` reads `<dataDir>/config.json` merging over `DEFAULT_CONFIG`; `saveConfig` writes it. All field-validators mirror cw-mem's conditional-assign pattern.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/config.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/config.js test/config.test.js
git commit -m "feat(config): defaults/load/save/mergeLlm with 3-section schema"
```

---

### Task 3: `lib/db.js` — SQLite + sqlite-vec, migrations, prepared statements

**Files:**
- Create: `lib/db.js`, `test/db.test.js`

**Interfaces:**
- Produces: `openDb(dataDir, embedDim)` returns `{ db }`; tables: `sessions`, `prompts`(incl. `injected_context`), `tool_details`, `session_summaries`, `memories_vec`(vec0), `memories_meta`.

- [ ] **Step 1: Write failing test `test/db.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../lib/db');

test('openDb creates tables and vec0 virtual table', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-db-'));
  const { db } = openDb(dir, 768);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  ['sessions','prompts','tool_details','session_summaries','memories_vec','memories_meta'].forEach(t => assert.ok(tables.includes(t), 'missing ' + t));
});

test('prompts row has injected_context and summary_meta columns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-db-'));
  const { db } = openDb(dir, 768);
  const cols = db.prepare('PRAGMA table_info(prompts)').all().map(c => c.name);
  assert.ok(cols.includes('injected_context'));
  assert.ok(cols.includes('summary_meta'));
});

test('reopening runs migrations idempotently', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-db-'));
  openDb(dir, 768);
  const { db } = openDb(dir, 768);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM prompts').get().c, 0);
});

test('insert and KNN query on memories_vec', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-db-'));
  const { db } = openDb(dir, 4);
  const v = Buffer.from(new Float32Array([0.1,0.2,0.3,0.4]).buffer);
  db.prepare('INSERT INTO memories_vec(rowid, embedding) VALUES (?, ?)').run(1, v);
  const q = Buffer.from(new Float32Array([0.1,0.2,0.3,0.4]).buffer);
  const rows = db.prepare('SELECT rowid, distance FROM memories_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 1').all(q);
  assert.equal(rows[0].rowid, 1);
});
```

> If sqlite-vec native extension fails to load on the test machine, guard the vec-KNN test with a try/catch that logs a skip (first verify load via `node -e "require('sqlite-vec').getLoadablePath()"`).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/db.test.js`
Expected: FAIL (Cannot find module '../lib/db').

- [ ] **Step 3: Implement `lib/db.js`**

- `openDb(dataDir, embedDim)`: open `<dataDir>/memory-lite.db` with better-sqlite3, `journal_mode=WAL`; `db.loadExtension(require('sqlite-vec').getLoadablePath())` (try/catch, log warn if unavailable).
- `ensureColumns()`: mirror cw-mem migration pattern (PRAGMA table_info checks) adding `type/tool_name/claude_prompt_id/response/summary/summary_meta/summary_status/retry_attempts/summary_error/summary_updated_at/injected_context` to `prompts`; create `sessions`, `prompts`, `tool_details`, `session_summaries`, `memories_meta`; `CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(embedding float[<embedDim>])`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/db.test.js`
Expected: PASS (4 tests, or 3 if vec skipped).

- [ ] **Step 5: Commit**

```bash
git add lib/db.js test/db.test.js
git commit -m "feat(db): sqlite + sqlite-vec open/migrate with memories_vec and injected_context"
```

---

### Task 4: `lib/embed.js` — ollama `/api/embed` client

**Files:**
- Create: `lib/embed.js`, `test/embed.test.js`

**Interfaces:**
- Produces: `embed({ url, model, input, timeoutSeconds })` → `Promise<number[][]>` (one vector per input item). `input` may be string or array.

- [ ] **Step 1: Write failing test `test/embed.test.js` using a fake HTTP server**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { embed } = require('../lib/embed');

function fakeOllama(statusCode, respBody) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let b = ''; req.on('data', c => b += c); req.on('end', () => {
        const body = JSON.parse(b);
        const n = Array.isArray(body.input) ? body.input.length : 1;
        res.writeHead(statusCode || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(respBody || { model: body.model, embeddings: Array.from({length:n}, () => [0.1,0.2,0.3]) }));
      });
    }).listen(0, '127.0.0.1', () => resolve(s));
  });
}

test('embed single string returns one vector', async () => {
  const s = await fakeOllama(); try {
    const vecs = await embed({ url: `http://127.0.0.1:${s.address().port}`, model: 'm', input: 'hello', timeoutSeconds: 5 });
    assert.equal(vecs.length, 1);
    assert.deepEqual(vecs[0], [0.1,0.2,0.3]);
  } finally { s.close(); }
});

test('embed array returns N vectors in order', async () => {
  const s = await fakeOllama(); try {
    const vecs = await embed({ url: `http://127.0.0.1:${s.address().port}`, model: 'm', input: ['a','b'], timeoutSeconds: 5 });
    assert.equal(vecs.length, 2);
  } finally { s.close(); }
});

test('embed rejects on non-200', async () => {
  const s = await fakeOllama(500, {}); try {
    await assert.rejects(() => embed({ url: `http://127.0.0.1:${s.address().port}`, model: 'm', input: 'x', timeoutSeconds: 5 }));
  } finally { s.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/embed.test.js`
Expected: FAIL (Cannot find module '../lib/embed').

- [ ] **Step 3: Implement `lib/embed.js`**

```js
const http = require('http');
const https = require('https');

function embed({ url, model, input, timeoutSeconds = 30 }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, input, truncate: true });
    const u = new URL(url.replace(/\/+$/,'') + '/api/embed');
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({ hostname: u.hostname, port: u.port || (u.protocol==='https:'?443:80), path: u.pathname, method: 'POST', headers: { 'Content-Type':'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('ollama http ' + res.statusCode + ': ' + b.slice(0,200)));
        try { resolve(JSON.parse(b).embeddings); } catch (e) { reject(new Error('ollama bad json')); }
      });
    });
    req.on('error', reject);
    setTimeout(() => { req.destroy(); reject(new Error('ollama timeout')); }, timeoutSeconds * 1000);
    req.write(body); req.end();
  });
}
module.exports = { embed };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/embed.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/embed.js test/embed.test.js
git commit -m "feat(embed): ollama /api/embed client (string or batch input)"
```

---

### Task 5: `lib/llm.js` — prompts, validateObservation, summarize, status helpers

**Files:**
- Create: `lib/llm.js`, `test/llm.test.js`

**Interfaces:**
- Produces: `TOOL_OBSERVATION_TEMPLATE`, `TOOL_OBSERVATION_SYSTEM`, `RESULT_SUMMARY_TEMPLATE`, `RESULT_SUMMARY_SYSTEM`, `SESSION_SUMMARY_TEMPLATE`, `SESSION_SUMMARY_SYSTEM`, `VALID_OBS_TYPES`, `VALID_OBS_CONCEPTS`, `validateObservation(obj)`, `summarize({ llm, kind, ... })`, `maxSummaryAttempts(cfg)`, `summaryTimeoutSeconds(cfg)`, `setSummaryStatus(db, rowId, status, extra)`.

- [ ] **Step 1: Write failing test `test/llm.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateObservation, VALID_OBS_TYPES, VALID_OBS_CONCEPTS, RESULT_SUMMARY_TEMPLATE } = require('../lib/llm');

test('validateObservation normalizes a valid object', () => {
  const o = validateObservation({ title:'x', type:'bugfix', concepts:['gotcha','nonsense'], filesChanged:['a.js',''], result:'ok' });
  assert.equal(o.type, 'bugfix');
  assert.deepEqual(o.concepts, ['gotcha']);
  assert.deepEqual(o.filesChanged, ['a.js']);
});

test('validateObservation defaults bad type to change', () => {
  assert.equal(validateObservation({ type:'unknown' }).type, 'change');
});

test('validateObservation returns null on non-object/array', () => {
  assert.equal(validateObservation(null), null);
  assert.equal(validateObservation('text'), null);
  assert.equal(validateObservation([]), null);
});

test('validateObservation fills concepts default when empty', () => {
  assert.deepEqual(validateObservation({ type:'feature' }).concepts, ['what-changed']);
});

test('RESULT_SUMMARY_TEMPLATE has 6 fields', () => {
  for (const f of ['request','investigated','learned','completed','next_steps','notes']) {
    assert.ok(RESULT_SUMMARY_TEMPLATE.includes(f), 'missing ' + f);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/llm.test.js`
Expected: FAIL (Cannot find module '../lib/llm').

- [ ] **Step 3: Implement `lib/llm.js`**

- Constants: `VALID_OBS_TYPES = ['bugfix','feature','refactor','change','discovery','decision','security','skip']`, `VALID_OBS_CONCEPTS = ['how-it-works','why-it-exists','what-changed','problem-solution','gotcha','pattern','trade-off']`.
- Three prompt pairs per spec §7: tool observation (fields: type/title/subtitle/facts/narrative/concepts/files_read/files_modified, JSON output, with recording_focus GOOD/BAD + skip_guidance borrowed from claude-mem `plugin/modes/code.json`), result summary (request/investigated/learned/completed/next_steps/notes), session summary (same 6 fields). Templates use `{placeholders}`.
- `validateObservation(obj)`: null/non-object/array → null; clamp type to valid (default `change`); filter concepts to valid (default `['what-changed']` if empty); filter filesChanged/filesRead to non-empty strings; trim strings. (Mirror cw-mem `validateObservation` plus richer fields.)
- `summarize({ llm, kind, ... })`: build payload per provider (openai-compatible vs anthropic), call endpoint, extract text. (Port `summarizeResponse` from cw-mem, take `kind` to pick template/system.)
- `setSummaryStatus(db, rowId, status, extra)`: port from cw-mem.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/llm.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/llm.js test/llm.test.js
git commit -m "feat(llm): 3 prompt templates + validateObservation + summarize + status helpers"
```

---

### Task 6: `lib/vector.js` — write embedding + KNN + hybrid file recall

**Files:**
- Create: `lib/vector.js`, `test/vector.test.js`

**Interfaces:**
- Consumes: `lib/db` (`openDb`).
- Produces: `storeEmbedding({ db, entity_type, ref_id, project, type, concepts, files_modified, text, embedding })`, `knnRecall({ db, queryVec, topK, project })`, `hybridFileRecall({ db, file, queryVec, topK, project })`, `vecToBuffer(vec)`, `normalize(vec)`.

- [ ] **Step 1: Write failing test `test/vector.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../lib/db');
const { storeEmbedding, knnRecall, hybridFileRecall, vecToBuffer } = require('../lib/vector');

function freshDb(dim=4) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-vec-'));
  return openDb(dir, dim);
}

test('storeEmbedding writes vec + meta and KNN finds it', () => {
  const { db } = freshDb();
  storeEmbedding({ db, entity_type:'result', ref_id:1, project:'p', type:'change', concepts:'[]', files_modified:'[]', text:'x', embedding:[0.1,0.2,0.3,0.4] });
  const rows = knnRecall({ db, queryVec: vecToBuffer([0.1,0.2,0.3,0.4]), topK:5, project:'p' });
  assert.ok(rows.some(r => r.ref_id === 1));
});

test('knnRecall filters by project', () => {
  const { db } = freshDb();
  storeEmbedding({ db, entity_type:'result', ref_id:1, project:'p1', type:'change', concepts:'[]', files_modified:'[]', text:'x', embedding:[0.1,0.2,0.3,0.4] });
  storeEmbedding({ db, entity_type:'result', ref_id:2, project:'p2', type:'change', concepts:'[]', files_modified:'[]', text:'x', embedding:[0.1,0.2,0.3,0.4] });
  const rows = knnRecall({ db, queryVec: vecToBuffer([0.1,0.2,0.3,0.4]), topK:10, project:'p1' });
  assert.ok(rows.every(r => r.project === 'p1'));
});

test('hybridFileRecall ranks by file then vector', () => {
  const { db } = freshDb();
  storeEmbedding({ db, entity_type:'tool', ref_id:10, project:'p', type:'change', concepts:'[]', files_modified:'["server.js"]', text:'a', embedding:[1,0,0,0] });
  storeEmbedding({ db, entity_type:'tool', ref_id:11, project:'p', type:'change', concepts:'[]', files_modified:'["server.js"]', text:'b', embedding:[0,1,0,0] });
  const rows = hybridFileRecall({ db, file:'server.js', queryVec: vecToBuffer([1,0,0,0]), topK:5, project:'p' });
  assert.equal(rows[0].ref_id, 10);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/vector.test.js`
Expected: FAIL (Cannot find module '../lib/vector').

- [ ] **Step 3: Implement `lib/vector.js`**

- `vecToBuffer(vec)`: `Buffer.from(new Float32Array(vec).buffer)`.
- `normalize(vec)`: L2-normalize so cosine ≈ L2.
- `storeEmbedding`: insert `memories_meta(rowid PK auto, entity_type, ref_id, project, type, concepts, files_modified, created_at)` → get rowid → `INSERT INTO memories_vec(rowid, embedding) VALUES (?, ?)`. Normalize the embedding before storing.
- `knnRecall`: `SELECT v.rowid, v.distance, m.* FROM memories_vec v JOIN memories_meta m ON v.rowid=m.rowid WHERE v.embedding MATCH ? ORDER BY v.distance LIMIT ?` then filter `project` + `type!='skip'` in JS. Return joined rows.
- `hybridFileRecall`: `SELECT rowid FROM memories_meta WHERE files_modified LIKE ?` (project filter) → rowids → `SELECT v.rowid, v.distance, m.* FROM memories_vec v JOIN memories_meta m ON v.rowid=m.rowid WHERE v.rowid IN (...) AND v.embedding MATCH ? ORDER BY v.distance LIMIT ?`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/vector.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/vector.js test/vector.test.js
git commit -m "feat(vector): store embedding + KNN + hybrid file recall"
```

---

### Task 7: `lib/recall.js` — assemble injection text (sessionStart + userPrompt)

**Files:**
- Create: `lib/recall.js`, `test/recall.test.js`

**Interfaces:**
- Consumes: `lib/vector` (`knnRecall`), `lib/embed` (`embed`), `lib/config`.
- Produces: `sessionStartInjection({ db, project, count })` → string, `userPromptInjection({ db, embedFn, cfg, project, prompt })` → `{ text, hits }`.

- [ ] **Step 1: Write failing test `test/recall.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../lib/db');
const { sessionStartInjection, userPromptInjection } = require('../lib/recall');
const { storeEmbedding, vecToBuffer } = require('../lib/vector');

test('sessionStartInjection returns recent session summaries for project', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-recall-'));
  const { db } = openDb(dir, 4);
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s1','/proj');
  db.prepare("INSERT INTO sessions(id, project_dir) VALUES(?,?)").run('s2','/proj');
  db.prepare("INSERT INTO session_summaries(session_id, request, learned, created_at) VALUES(?,?,?,?)").run('s1','do X','learned X','2026-09-01');
  db.prepare("INSERT INTO session_summaries(session_id, request, learned, created_at) VALUES(?,?,?,?)").run('s2','do Y','learned Y','2026-09-02');
  const text = sessionStartInjection({ db, project:'/proj', count:5 });
  assert.ok(text.indexOf('do Y') < text.indexOf('do X')); // most recent first
});

test('sessionStartInjection empty when no summaries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-recall-'));
  const { db } = openDb(dir, 4);
  assert.equal(sessionStartInjection({ db, project:'/proj', count:5 }), '');
});

test('userPromptInjection respects injectMaxCount and minScore', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-recall-'));
  const { db } = openDb(dir, 4);
  storeEmbedding({ db, entity_type:'result', ref_id:1, project:'p', type:'change', concepts:'[]', files_modified:'[]', text:'t1', embedding:[1,0,0,0] });
  storeEmbedding({ db, entity_type:'result', ref_id:2, project:'p', type:'change', concepts:'[]', files_modified:'[]', text:'t2', embedding:[0.9,0.1,0,0] });
  const fakeEmbed = async () => [[1,0,0,0]];
  const cfg = { ollama:{ url:'http://x', embedModel:'m' }, recall:{ topK:5, minScore:0.0, injectMaxCount:1, injectMaxTokens:800 } };
  const { hits } = await userPromptInjection({ db, embedFn:fakeEmbed, cfg, project:'p', prompt:'q' });
  assert.ok(hits.length <= 1);
  assert.equal(hits[0] && hits[0].ref_id, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/recall.test.js`
Expected: FAIL (Cannot find module '../lib/recall').

- [ ] **Step 3: Implement `lib/recall.js`**

- `sessionStartInjection`: join `session_summaries` ↔ `sessions` on session_id, filter `sessions.project_dir = project`, order by `created_at DESC LIMIT count`; build text from `request`/`learned`/`next_steps`.
- `userPromptInjection`: `embedFn({url,model,input:prompt})` → query vector (buffered via `vecToBuffer`); `knnRecall` topK; compute `sim = 1/(1+distance)` (monotonic; sqlite-vec returns L2 squared — normalize embeddings at store time so this is a valid similarity proxy); filter `sim >= minScore`, `type !== 'skip'`, same project, dedupe by ref_id, slice `injectMaxCount`; `hits = [{entity_type, ref_id, title, score}]` (read title from `summary_meta` via ref_id); `text` = `## 相关过往工作` + each hit's title/subtitle + files_modified, char-trimmed to `injectMaxTokens`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/recall.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/recall.js test/recall.test.js
git commit -m "feat(recall): sessionStart recency + userPrompt semantic injection assembly"
```

---

### Task 8: `lib/server.js` — HTTP server + routes + static UI + lazy-start

**Files:**
- Create: `lib/server.js`, `test/server.test.js`
- Modify: `package.json` (add `start` script)

**Interfaces:**
- Consumes: all `lib/*`.
- Produces: `startServer({ dataDir, uiDir, port })` → `{ server, port }`. Routes: `GET /api/health`, `GET/POST /api/config`, `POST /api/restart`, `POST /api/sessions`, `POST /api/prompts`, `POST /api/prompts/response`, `POST /api/prompts/summarize`, `POST /api/prompts/summarize-retry`, `POST /api/tool-details`, `POST /api/prompts/tool-summary`, `POST /api/recall/semantic`, `POST /api/sessions/summarize`, `GET /api/prompts`, `GET /api/memories`, `GET /api/sessions`, `GET /api/projects`, `GET /api/stats`, static UI.

- [ ] **Step 1: Write integration test `test/server.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let serverHandle, port, dir;
async function boot() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-srv-'));
  const { startServer } = require('../lib/server');
  const handle = await startServer({ dataDir: dir, uiDir: path.join(__dirname,'..','ui'), port: 0 });
  serverHandle = handle.server; port = handle.port;
}
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname:'127.0.0.1', port, path:p, method, headers:{'Content-Type':'application/json'} }, res => {
      let b=''; res.on('data',c=>b+=c); res.on('end',()=>resolve({status:res.statusCode,body:b}));
    });
    r.on('error',reject); if(body) r.write(JSON.stringify(body)); r.end();
  });
}

test('GET /api/health returns ok', async () => { await boot(); try {
  assert.equal(JSON.parse((await req('GET','/api/health')).body).status, 'ok');
} finally { serverHandle.close(); fs.rmSync(dir,{recursive:true}); } });

test('POST /api/sessions + /api/prompts creates a row', async () => { await boot(); try {
  await req('POST','/api/sessions', { sessionId:'s1', projectDir:'/p' });
  const j = JSON.parse((await req('POST','/api/prompts', { sessionId:'s1', prompt:'hi', type:'PROMPT', claudePromptId:'cp1', projectDir:'/p' })).body);
  assert.equal(j.status,'ok'); assert.ok(j.id > 0);
} finally { serverHandle.close(); fs.rmSync(dir,{recursive:true}); } });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server.test.js`
Expected: FAIL (Cannot find module '../lib/server').

- [ ] **Step 3: Implement `lib/server.js`**

Port structure from cw-mem `ui/server.js`: `startServer({ dataDir, uiDir, port })` opens db (via `lib/db` with current `embedDim` from config), loads config (via `lib/config`), creates `http.createServer` with try/catch router. Routes mirror cw-mem's set (listed in Interfaces) plus:
- `/api/recall/semantic` (POST): calls `lib/recall.userPromptInjection`, writes `injected_context` to the prompt row, returns `{ text }`.
- `/api/sessions/summarize` (POST): queues SessionEnd summary (Task 10).
- `/api/memories` (GET): port from cw-mem, exclude `type=skip` (parameter-bound, NOT double-quoted — the bug we fixed).
Static file serving for `ui/index.html`. `doRestart`/`bindWithRetry` ported. `startSummaryRetryTimer` ported. `module.exports = { startServer }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Add `start` script and commit**

```json
"scripts": { "test": "node --test test/", "start": "node lib/server.js" }
```

```bash
git add lib/server.js test/server.test.js package.json
git commit -m "feat(server): HTTP server + routes + static UI + lazy-start"
```

---

### Task 9: Hooks (5 bash handlers)

**Files:**
- Create: `hooks-handlers/session-start.sh`, `user-prompt-submit.sh`, `post-tool-use.sh`, `stop.sh`, `session-end.sh`

**Interfaces:**
- Each hook reads stdin JSON, POSTs to server, returns the appropriate stdout JSON.

- [ ] **Step 1: Port `post()` helper + stdin read pattern from cw-mem**

Each handler sources `_log.sh`, reads stdin into `RAW_JSON`, then runs inline node that parses fields and POSTs. Reuse cw-mem's `post(pathname, body)` returning `{ok, body, id}`.

- [ ] **Step 2: Implement `session-start.sh`**

- Ensure server running: spawn `nohup node "$PLUGIN_ROOT/lib/server.js" "$DATA_DIR" "$PLUGIN_ROOT/ui" >/dev/null 2>&1 &` if `curl /api/health` fails (mirror cw-mem lazy-start).
- Call `GET /api/recall/session?project=<cwd>` (server returns recent session-summaries injection text).
- stdout: `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<text>"},"systemMessage":"🧠 memory-lite 已生效"}` (if text empty, emit minimal banner only).

- [ ] **Step 3: Implement `user-prompt-submit.sh`**

- Parse `session_id`, `prompt`, `prompt_id`, `cwd`, `source`.
- `POST /api/sessions`, `POST /api/prompts` (type=PROMPT), `POST /api/recall/semantic` `{promptId, sessionId, project:cwd, prompt}` → `{text, hits}` (server persists `injected_context`).
- stdout: `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<text>"}}` (if no text, `{"continue":true,"suppressOutput":true}`).

- [ ] **Step 4: Implement `post-tool-use.sh`**

- Read config `toolSummary.enabled`; if false → `{"continue":true,"suppressOutput":true}` exit.
- Parse `session_id`, `prompt_id`, `cwd`, `tool_name`, `tool_use_id`, `duration_ms`, `tool_input`, `tool_response{...}`.
- `POST /api/sessions`, `POST /api/prompts` (type=TOOL), `POST /api/tool-details`. (No LLM — Stop does batch.)
- stdout: `{"continue":true,"suppressOutput":true}`.

- [ ] **Step 5: Implement `stop.sh`**

- Parse `session_id`, `prompt_id`, `last_assistant_message`.
- `POST /api/prompts/response` `{promptId, sessionId, response}`; `POST /api/prompts/summarize` `{promptId, sessionId}` (server queues Stop batch).
- stdout: `{"continue":true,"suppressOutput":true}`.

- [ ] **Step 6: Implement `session-end.sh`**

- Parse `session_id`, `transcript_path`, `cwd`, `prompt_id`, `reason`.
- `POST /api/sessions/summarize` `{sessionId, reason}`.
- stdout: `{"continue":true,"suppressOutput":true}`.

- [ ] **Step 7: Manual verification**

Temporarily add `log.info("[HOOK] stdin=$RAW_JSON")` to each handler; run a real Claude Code session; send a prompt, use a tool, stop, exit. Confirm `~/.memory-lite/memory-lite-<date>.log` shows the verified stdin fields (spec §2.1) and the `POST /api/...` lines. Remove debug logs after.

- [ ] **Step 8: Commit**

```bash
git add hooks-handlers/*.sh
git commit -m "feat(hooks): 5 hook handlers (record, recall+inject, batch-trigger)"
```

---

### Task 10: Server-side summarization + vectorization wiring (Stop batch + SessionEnd)

**Files:**
- Modify: `lib/server.js` (endpoints `/api/prompts/summarize`, `/api/sessions/summarize` + async workers), `lib/llm.js` (batch tool-observation prompt builder), `lib/vector.js`, `lib/recall.js`.
- Create: `test/batch.test.js`

- [ ] **Step 1: Implement Stop batch in server**

`POST /api/prompts/summarize`: look up the PROMPT row + its TOOL rows (by `claude_prompt_id`/session) + tool_details. If `toolSummary.enabled`: build a batch tool-observation prompt (all the turn's tool calls) → `llm.summarize({kind:'tool', ...})` → `validateObservation` → store `summary_meta` on each TOOL row + `lib/embed` + `storeEmbedding`. Always: build result-summary prompt (prompt + response + tool observation titles) → `llm.summarize({kind:'result', ...})` → store on PROMPT row + embed. Status machine `pending→generating→success/failed` + retry timer.

- [ ] **Step 2: Implement SessionEnd summary in server**

`POST /api/sessions/summarize`: gather the session's PROMPT result-summaries (+ tool observations if enabled) → `llm.summarize({kind:'session', ...})` → store `session_summaries` row + embed.

- [ ] **Step 3: Write test `test/batch.test.js`**

Seed a session + 1 PROMPT + 2 TOOL rows + tool_details; stub `llm.summarize` to return canned JSON; call the summarize endpoint; assert TOOL rows got `summary_meta` and `memories_meta` got 3 rows (2 tool + 1 result); assert result PROMPT row got `summary`.

- [ ] **Step 4: Run + commit**

```bash
node --test test/batch.test.js
git add lib/server.js lib/llm.js lib/vector.js lib/recall.js test/batch.test.js
git commit -m "feat(summarize): Stop batch (tool obs + result) and SessionEnd summary with vectorization"
```

---

### Task 11: `ui/index.html` — history cards (linkage + injected_context) + 3-section config + 3 buttons

**Files:**
- Create: `ui/index.html`

- [ ] **Step 1: Port UI shell from cw-mem**

Copy cw-mem `ui/index.html` structure (header w/ project select + theme + settings; prompt list; settings modal with `取消/保存/保存并重启`); adapt fetch endpoints to memory-lite; retheme brand.

- [ ] **Step 2: Render linkage**

In `render(list)` / `cardBody(p)`: tool cards show `↳ 归属提示词 #<promptIdMap[claude_prompt_id]>` (port cw-mem `parentHtml`); result summary (`summary_meta`) renders on the PROMPT card (port cw-mem `renderSummary` + `renderObservation`); session summaries render on a session header section.

- [ ] **Step 3: Render `injected_context` block**

On each PROMPT card, parse `p.injected_context` JSON → render `注入的记忆` block listing `{title, score}`. Subtle inline styling.

- [ ] **Step 4: 3-section config modal**

`基础` (server.port, log.*), `LLM 与向量化` (llm.*, ollama.*), `记忆与召回` (toolSummary.*, recall.*). `renderSettingsForm` reads config; `buildPayload` writes; "needs restart" tag on port/ollama.url/ollama.embedModel/ollama.embedDim.

- [ ] **Step 5: Manual verification**

Run server, open `http://localhost:37889`, run a real Claude Code session so hooks fire; confirm: prompt appears; tool card links to prompt; result summary shows on prompt card; injected_context block shows hits; config modal saves (save + save&restart); changing port shows restart note.

- [ ] **Step 6: Commit**

```bash
git add ui/index.html
git commit -m "feat(ui): history cards with linkage + injected_context + 3-section config modal"
```

---

### Task 12: Marketplace registration + install + update verification

**Files:**
- Modify: `.claude-plugin/marketplace.json` (finalize `<github-repo>`/`<owner>`), `package.json` version.

- [ ] **Step 1: Finalize placeholders**

Replace `<owner>` and `<github-repo>` in `.claude-plugin/marketplace.json` and `plugin.json` once the user provides them.

- [ ] **Step 2: Publish + install**

Push repo to GitHub; in Claude Code run `/plugin marketplace add <github-repo>` then `/plugin install memory-lite@memory-lite`. Confirm it appears in `~/.claude/plugins/cache/memory-lite/memory-lite/<version>/`.

- [ ] **Step 3: Verify update**

Bump `marketplace.json` `plugins[].version` and `package.json` version; push; run `/plugin update`; confirm new version in cache (`installed_plugins.json` `lastUpdated` changes).

- [ ] **Step 4: End-to-end smoke**

New Claude Code session: confirm SessionStart injection + recalled summaries; send a prompt → UserPromptSubmit injection + card; use a tool → tool card linked; stop → result summary; exit → session summary. Check `~/.memory-lite/` db has rows + vectors.

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin/marketplace.json .claude-plugin/plugin.json package.json
git commit -m "chore: finalize marketplace metadata for install + auto-update"
```

---

## Self-Review

**Spec coverage:** spec §2 facts → Global Constraints + Task 1/9. §3 architecture → Tasks 8-10. §5 data model → Task 3. §6 hook behavior → Tasks 9 + 10. §7 prompts → Task 5. §8 vectorization/recall → Tasks 4/6/7/10. §9 config → Task 2 + 11. §10 errors → Task 8/10 (async, status machine). §11 marketplace → Task 12. §12 verification → each task's verify step + Task 12 e2e. §13 placeholders → Task 1/12. All covered.

**Type consistency:** `validateObservation` fields (type/title/subtitle/facts/narrative/concepts/files_read/files_modified) used in Task 5/10/11. `storeEmbedding`/`knnRecall`/`hybridFileRecall` signatures consistent across Task 6/7/10. `userPromptInjection` returns `{text, hits}` (Task 7), consumed by `/api/recall/semantic` (Task 8). `startServer({dataDir, uiDir, port})` returns `{server, port}` (Task 8/9). `embed({url, model, input, timeoutSeconds})` → `number[][]` (Task 4/7/10).

**Distance metric:** sqlite-vec returns L2 squared. Embeddings are L2-normalized at store time (Task 6 `normalize`), so `sim = 1/(1+distance)` (Task 7) is a valid monotonic similarity for `minScore`. Non-normalized vectors would break this — normalize-on-store is mandatory.

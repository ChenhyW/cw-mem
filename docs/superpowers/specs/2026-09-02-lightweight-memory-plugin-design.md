# 设计方案:memory-lite —— 轻量级持久化记忆插件(Claude Code)

> 日期:2026-09-02 · 状态:Spec(待实现) · 插件占位名 `memory-lite` / 仓库占位 `<repo-url>`
>
> 设计原则:所有结论用事实验证(见"已验证事实基线"),不猜测;遵循 YAGNI;闭环(记录→召回→注入)永不断。

## 1. Context(为什么做)

需要一个**轻量级**的 Claude Code 持久化记忆插件:跨会话记住"做过什么、学到什么、决定什么",并在新会话/新提示词时**召回注入**,提高回答准确性。

对标 `claude-mem`(桌面 `~/Desktop/claude-mem`,已读源码):其召回质量高(后台 observer + Chroma 向量),但栈重(bun + Python/uvx + MCP + 独立 observer LLM 会话),与"轻量"相悖。本插件取其**思路**(结构化 observation、type 分类、skip 降噪、subtitle 一句话注入、hybrid 召回),换用 **ollama 向量化 + sqlite-vec + 无并行 LLM 的批量回顾**实现,守住轻量。

参考实现 `cw-mem`(`/Volumes/KINGSTON-CHENHY/plugins/cw-mem`,已读源码):其 hook 处理器、lazy-start HTTP server、SQLite、UI 设置弹框模式可直接借鉴;但 cw-mem **无真实注入**(只用 `systemMessage` 发静态 banner),本插件从零实现注入。

## 2. 已验证事实基线(非猜测)

### 2.1 hook 事件与 stdin payload

| Hook | stdin 字段(实测) | 来源 |
|---|---|---|
| SessionStart | `session_id`, `cwd` | cw-mem `session-start.sh` |
| UserPromptSubmit | `session_id`, `prompt`, `prompt_id`, `cwd`, `source`, `transcript_path`, `permission_mode`, `hook_event_name` | cw-mem `user-prompt-submit.sh` |
| PostToolUse | `session_id`, `prompt_id`, `cwd`, `tool_name`, `tool_use_id`, `duration_ms`, `tool_input`, `tool_response{stdout,stderr,interrupted,isImage,noOutputExpected}` | cw-mem `post-tool-use.sh`(注释明确:无 `tool_output`/`exit_code`) |
| Stop | `session_id`, `prompt_id`, `last_assistant_message` | cw-mem `stop.sh` |
| SessionEnd | `session_id`, `transcript_path`, `cwd`, `prompt_id`, `hook_event_name`, `reason`(如 `prompt_input_exit`) | 我加探测 hook 实测(2026-09-02 16:29 日志) |

### 2.2 注入契约(给 Claude 的上下文)

hook stdout 为 JSON,两个通道(来源:claude-mem `src/shared/hook-io.ts`、`src/cli/adapters/claude-code.ts`):
- `hookSpecificOutput.additionalContext` —— **模型消费的上下文**(注入用此);
- `systemMessage` —— 用户可见提示(仅 banner/状态,不用作注入)。

`hookSpecificOutput.hookEventName` 必须匹配当前事件(如 `SessionStart` / `UserPromptSubmit`)。

### 2.3 ollama 向量化

`POST http://localhost:11434/api/embed`(默认端口 11434,无鉴权):
- 请求:`{ "model": "<embedModel>", "input": "<text>" | ["t1","t2"], "truncate": true, "dimensions": <int>? }`
- 响应:`{ "model": "...", "embeddings": [[...]], "total_duration":..., "load_duration":..., "prompt_eval_count":... }`
- 批量输入返回 `embeddings` 数组(每输入一个向量)。

### 2.4 插件注册与更新

- 仓库根 `.claude-plugin/marketplace.json`:`{name, owner, metadata, plugins:[{name, version, source:".", description}]}`;`.claude-plugin/plugin.json`:插件元数据。
- 用户:`/plugin marketplace add <github-repo>` → `/plugin install <name>@<marketplace>`。
- 更新:`/plugin update` 重新拉取;`known_marketplaces.json` 里 `autoUpdate` 是 marketplace 级开关。
- 运行副本落在 `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`,hook 用 `${CLAUDE_PLUGIN_ROOT}` 解析。
- 来源:本机 `installed_plugins.json`、`known_marketplaces.json`(cw-mem 实例)。

> sqlite-vec 的 `vec0`/`MATCH` 语法按其公开文档描述;实现时先用最小用例(建表+插 1 条+KNN)验证再铺开。

## 3. 架构(方案:轻量 observer + ollama + sqlite-vec)

单节点:`bash hook → 本地 node HTTP server(lazy-start 由 SessionStart 触发,沿用 cw-mem 模式)→ better-sqlite3 + sqlite-vec + ollama + LLM`。UI 由同一 server 提供。

**"轻量 observer"含义**:不跑第二个 LLM 会话。在 **Stop(每轮)和 SessionEnd(每会话)做批量回顾**——把本轮/本会话的全部工具调用 + 用户提示词 + 最终回复一次性喂 LLM,产出合并后的 observation/summary。这拿到 claude-mem observer 的主要收益(跨调用 skip/合并、带用户意图)而无 Python/MCP/bun/并行 LLM 的成本。

**取舍**:
- 工具观察:PostToolUse 只**廉价记录原始** input/output(不调 LLM);Stop 做**批量 LLM 摘要**(含跨调用 skip/合并)。
- 摘要延迟到轮末/会话末;召回注入发生在**下一提示词/下一会话**,故延迟不影响注入。
- 省掉常驻 observer LLM 会话的 token 开销。

## 4. 组件

- `hooks/hooks.json`:注册 5 个 hook。
- `hooks-handlers/*.sh`:5 个 bash 处理器(内联 node 调 HTTP,沿用 cw-mem 的 `post()` 模式与 `_log.sh`)。
- `ui/server.js`:node HTTP server。DB、LLM 摘要、ollama embed、召回、注入文本组装、UI 静态服务、lazy-start。
- `ui/index.html`:历史 + 配置 UI(沿用 cw-mem 设置弹框 + 取消/保存/保存并重启)。
- `~/.memory-lite/config.json` + `~/.memory-lite/memory-lite.db` + `~/.memory-lite/logs`。
- `.claude-plugin/{marketplace.json, plugin.json}`。

## 5. 数据模型(SQLite + sqlite-vec)

沿用 cw-mem 表结构,新增 `injected_context` 列、`session_summaries` 表、向量表。

```sql
sessions(id TEXT PK, started_at TEXT, project_dir TEXT);

prompts(
  id INTEGER PK AUTOINCREMENT,
  session_id TEXT, prompt TEXT, type TEXT,        -- PROMPT | TOOL
  tool_name TEXT, response TEXT,
  summary TEXT,                                   -- 兼容旧 5 字段文本(回退用)
  summary_meta TEXT,                               -- JSON: 结构化 observation/summary
  summary_status TEXT, retry_attempts INT, summary_error TEXT, summary_updated_at TEXT,
  injected_context TEXT,                          -- JSON: 本提示词被注入的召回命中列表(透明化)
  claude_prompt_id TEXT, project_dir TEXT, timestamp TEXT
);

tool_details(prompt_id INT, input_json TEXT, output_json TEXT, tool_use_id TEXT, duration_ms TEXT, claude_prompt_id TEXT);

session_summaries(
  id INTEGER PK, session_id TEXT,
  request TEXT, investigated TEXT, learned TEXT, completed TEXT, next_steps TEXT, notes TEXT,
  summary_meta TEXT,                               -- JSON 同结构
  created_at TEXT
);

-- 向量虚表(KNN)
CREATE VIRTUAL TABLE memories_vec USING vec0(embedding float[<embedDim>]);
-- 元数据(过滤)
memories_meta(rowid INT, entity_type TEXT,        -- tool | result | session
              ref_id INT, project TEXT, type TEXT, -- observation 9 类(可 skip)
              concepts TEXT, files_modified TEXT, created_at TEXT);
```

- `embedDim` 由 config `ollama.embedDim` 定(如 nomic-embed-text=768);改维度需重建向量表 → 标"需重启"。
- 工具摘要关闭时不写 tool 向量;result/session 向量始终写。

## 6. hook → 行为(可配置性已固化)

| Hook | 行为 | 可配置 |
|---|---|---|
| SessionStart | ① 启 server(lazy);② 注入该 project 最近 N 条会话摘要(`additionalContext`, hookEventName=`SessionStart`)。N=`recall.sessionStartCount` | 数值旋钮;**注入本身必开** |
| UserPromptSubmit | ① 记录提示词(PROMPT 行,`prompt`/`prompt_id`);② 语义召回:ollama embed(prompt)→ sqlite-vec KNN → 过滤(project+minScore+type≠skip)→ 写 `injected_context` 到该行 → `additionalContext`(hookEventName=`UserPromptSubmit`) | 数值旋钮;**注入本身必开** |
| PostToolUse | 廉价记录原始 input/output 到 `tool_details`(不调 LLM) | 受 `toolSummary.enabled` 总开关:关则不记(且 UI 不展示工具卡) |
| Stop | ① 写回 `response`(按 claude_prompt_id);② **必生成**结果摘要:喂料=用户提示词+最终回复+(若开启)本轮工具观察 → LLM(6 字段 summary 结构)→ embed → 存向量;③ 若工具摘要开:批量生成工具 observation(含跨调用 skip/合并)→ embed → 存向量 | 结果摘要**必开**;工具 observation 受 `toolSummary.enabled` |
| SessionEnd | **必生成**会话摘要:喂料=全会话 result 摘要+(若开启)工具观察 → LLM → embed → 存向量 | **必开** |

**必开项(不做成开关)**:结果摘要(Stop)、会话摘要(SessionEnd)、SessionStart 注入、UserPromptSubmit 注入。
**可取舍项**:`toolSummary.enabled/skipMode`、召回数值旋钮。
理由:保证闭环永不断——召回池至少有 result+session 摘要,注入至少有 UserPromptSubmit 语义注入。

## 7. 提示词(参考 claude-mem 结构,JSON 输出)

输出统一为**合法 JSON**(便于注入端解析),不沿用 claude-mem 的 XML;结构与引导借鉴 claude-mem 的 `code.json`。

### 7.1 工具观察(Stop 批量)

字段:`type`(9 类:`bugfix/feature/refactor/change/discovery/decision/security/skip`,claude-mem 同名)、`title`、`subtitle`(一句话≤24 词,**注入摘要用**)、`facts[]`(多条独立事实,无代词)、`narrative`(完整上下文:做了什么/怎么做/为什么)、`concepts[]`(7 类:`how-it-works/why-it-exists/what-changed/problem-solution/gotcha/pattern/trade-off`)、`files_read[]`、`files_modified[]`。

system 引导抄 claude-mem 的 `recording_focus`(GOOD/BAD 示例 + 动词清单 implemented/fixed/deployed/...)、`skip_guidance`(空输出/重复状态检查/纯读取无后续/无错环境命令/同文件重复写 → `type=skip`)、`type_guidance`、`concept_guidance`。
批量喂料含**本轮全部工具调用**,让 LLM 跨调用判断 skip/合并。

### 7.2 结果摘要(Stop,每提示词)

字段(claude-mem summary 结构):`request`/`investigated`/`learned`/`completed`/`next_steps`/`notes`。
喂料=用户提示词 + 最终回复 + 本轮工具观察(若有)。

### 7.3 会话摘要(SessionEnd)

同 7.2 结构。喂料=全会话 result 摘要 + 工具观察(若开启)。

### 提示词固化

三套提示词固化为代码契约(不暴露给用户编辑),因格式与注入端解析耦合。

## 8. 向量化与召回

### 写侧(只 embed 摘要,不 embed 原始)

| 单元 | 何时 | embed 文本 | 向量数 |
|---|---|---|---|
| 工具观察 | Stop 批量(若开启) | title+subtitle+narrative | 每条 1 |
| 结果摘要 | Stop | summary 文本 | 每提示词 1 |
| 会话摘要 | SessionEnd | summary 文本 | 每会话 1 |

每向量带元数据 `memories_meta`(entity_type/ref_id/project/type/concepts/files_modified/created_at)。

### 读侧

- **UserPromptSubmit(语义)**:prompt → ollama embed → `SELECT rowid, distance FROM memories_vec WHERE embedding MATCH ? ORDER BY distance LIMIT <topK>` → JS 后过滤(同 project + `minScore` + type≠skip + 去重)→ 取命中 `subtitle`+`files_modified` 拼注入文本 → 按 `injectMaxTokens` 裁剪、`injectMaxCount` 限条数 → `additionalContext`。
- **文件级召回(hybrid)**:先 `memories_meta` 按 `files_modified LIKE '%<file>%'` 取 rowid 集 → 再对该集做向量 KNN 排序(SQL 元数据过滤 ∩ 向量相似度)。
- **SessionStart(时间近邻,非语义)**:该 project 最近 N 条 `session_summaries`(按 `created_at` desc,`sessionStartCount` 条)→ 注入其 `request`+`learned`+`next_steps`。非语义因会话刚开无查询词。

### 透明化

UserPromptSubmit 召回命中写入该 prompt 行 `injected_context`(JSON:`[{entity_type, ref_id, title, score}]`);UI 卡片显示「注入的记忆」块。SessionStart 注入显示在会话头。

## 9. 配置(3 区,UI 编辑,取消/保存/保存并重启)

```jsonc
{
  "server": { "port": 37889 },
  "log":    { "level": "info", "retentionDays": 3, "maxPreviewChars": 40 },
  "llm":    { "enabled": false, "provider": "openai-compatible", "apiBase": "https://api.openai.com/v1",
              "model": "", "apiKey": "", "maxTokens": 4096, "reasoningEffort": "",
              "maxRetries": 3, "retryIntervalSeconds": 60, "timeoutSeconds": 30, "summaryFieldLimit": 2000 },
  "ollama": { "url": "http://localhost:11434", "embedModel": "nomic-embed-text", "embedDim": 768, "timeoutSeconds": 30 },
  "toolSummary": { "enabled": false, "skipMode": "on" },
  "recall": { "topK": 20, "minScore": 0.30, "injectMaxCount": 5, "injectMaxTokens": 800, "sessionStartCount": 3 }
}
```

UI 分区:
- **基础**:`server.port`;`log.*`
- **LLM 与向量化**:`llm.*`;`ollama.*`
- **记忆与召回**:`toolSummary.*`;`recall.*`

"需重启":改 `server.port` / `ollama.url` / `ollama.embedModel` / `ollama.embedDim`(进程级或重建向量表)。其余即时生效(hook 读 config.json)。三按钮:取消 / 保存 / 保存并重启。

## 10. 错误处理与降级

- **hook 永远是薄层**:只 POST 到 server 后立即返回(hook timeout 内完成);所有重活(LLM 摘要、ollama embed、sqlite-vec 写入、召回)在 **server 侧异步**做,绝不阻塞 hook 或拖慢 Claude。Stop/SessionEnd 的批量摘要同理:hook POST 触发即返回,server 异步处理;超时或进程重启由摘要状态机 + 定时器兜底补做。
- server 不可达:hook 静默 `{"continue":true,"suppressOutput":true}`,不阻断 Claude(沿用 cw-mem)。
- LLM 失败:摘要状态机 `pending→generating→success/failed_pending_retry→failed_final`,定时器重试(沿用 cw-mem)。
- ollama 不可达:跳过向量化(摘要仍存,embedding 置空);召回回退 SQL 关键词过滤。
- sqlite-vec 扩展加载失败:回退 JS 余弦(取 project 内全量向量计算),或 config 关闭向量召回。
- 注入文本超 `injectMaxTokens`:裁剪到预算内。

## 11. 插件注册与自动更新(req 9)

- 仓库根 `.claude-plugin/marketplace.json`:`{name:"memory-lite", owner:{name:"<owner>"}, metadata:{description}, plugins:[{name:"memory-lite", version:"0.1.0", source:".", description}]}`;`.claude-plugin/plugin.json`:`{name, version, author, description}`。
- 安装:`/plugin marketplace add <github-repo>` → `/plugin install memory-lite@memory-lite`。
- 自动更新:marketplace `autoUpdate:true`;版本号写在 `marketplace.json` 的 `plugins[].version`,Claude Code 据此判断更新。
- 占位 `<github-repo>` / `<owner>` 待定。

## 12. 验证计划(贯彻 #10)

1. hook 格式:已实测(2.1),无需再猜。
2. ollama:`curl -X POST localhost:11434/api/embed -d '{"model":"nomic-embed-text","input":"test"}'` 实测。
3. sqlite-vec:最小用例(加载扩展→建 vec0 表→插 1 条→`embedding MATCH` KNN)验证语法,再铺开。
4. 注入生效:SessionStart/UserPromptSubmit hook 把本次 `additionalContext` 写一份到日志,人工确认 Claude 读取了注入内容(或用依赖注入记忆的问答验证)。
5. 召回:构造 2 条向量 + 1 条 query,确认 KNN 命中、minScore 过滤、type≠skip 过滤生效。
6. 跳过:构造"空输出/纯读取无后续"工具调用,确认 Stop 批量标 `type=skip` 且不进 `/api/memories` 召回。
7. UI 一一对应:工具卡显示"↳ 归属提示词 #X";结果摘要在该提示词卡内;会话摘要在会话头;注入命中的 prompt 卡显示「注入的记忆」。

## 13. 占位与待定

- 插件名 `memory-lite`、`<github-repo>`、`<owner>`:占位,定稿前填。
- `ollama.embedModel` 默认 `nomic-embed-text`(768);中文更强可选 `bge-m3`(1024)。config 可改,改维度需重建向量表。
- 仓库结构(单 plugin vs marketplace 多 plugin):默认单 plugin(`source:"."`)。

## 14. 后续(实现阶段)

本 spec 批准后,转 writing-plans 出实现计划,再按计划落地。实现顺序建议:
1. 仓库骨架 + `.claude-plugin/*` + hooks.json + lazy-start server + DB schema。
2. 记录链路(SessionStart/UserPromptSubmit/PostToolUse/Stop/SessionEnd 写 DB)。
3. LLM 摘要(三套提示词)+ 状态机。
4. ollama embed + sqlite-vec 写入与 KNN 召回。
5. 注入(SessionStart + UserPromptSubmit 的 additionalContext + injected_context 落库)。
6. UI(历史卡片一一对应 + 注入块 + 3 区配置 + 三按钮)。
7. marketplace 注册与安装验证。

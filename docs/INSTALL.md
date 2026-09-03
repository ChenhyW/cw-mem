# cw-mem — 安装与验证

> 本文档对应实现计划 Task 12。代码侧已全部完成并通过单测;以下步骤需在 GitHub + 真实 Claude Code 会话中由用户执行。

## 前置依赖

- **Node.js ≥ 18**(本机已验证 v24)
- **ollama** 运行在本机(`http://127.0.0.1:11434`),拉取嵌入模型:`ollama pull nomic-embed-text`
- **LLM**(可选但推荐):OpenAI 兼容或 Anthropic 的 API Key,用于摘要生成。未配置时闭环不断,摘要落 `failed_final`。

## 1. 发布到 GitHub

```bash
cd /Volumes/KINGSTON-CHENHY/plugins/cw-mem
git remote add origin <你的-github-repo>   # 例如 git@github.com:chenhy/cw-mem.git
git push -u origin main
```

`source: "."` 表示插件源就是仓库根,无需额外目录。

## 2. 安装到 Claude Code

在 Claude Code 中:

```
/plugin marketplace add <你的-github-repo>
/plugin install cw-mem@cw-mem
```

确认运行副本落在 `~/.claude/plugins/cache/cw-mem/cw-mem/<version>/`。

**关键:在运行副本里安装依赖**(`node_modules/` 被 gitignore,不会随仓库分发;不装则 hook 调 `better-sqlite3` 直接报错):

```bash
cd ~/.claude/plugins/cache/cw-mem/cw-mem/<version>/
npm install
```

> `/plugin update` 后缓存会出现新版本目录,同样需要在新目录里重新 `npm install`。

## 3. 配置(UI)

打开 `http://localhost:37889`(默认端口),点 ⚙️:

- **基础**:端口(改需重启)、日志级别/保留/预览
- **LLM 与向量化**:
  - 开启摘要生成;填 provider / API Base / 模型 / API Key
  - ollama URL / 嵌入模型(`nomic-embed-text`)/ 嵌入维度(768)。改这三项需"保存并重启"
- **记忆与召回**:工具调用摘要开关(默认关,省 token)、skip 模式、topK / minScore / SessionStart 注入条数 / UserPrompt 注入最多条数 / 注入最大字符数

点「保存」即时生效;改了"需重启"项点「保存并重启」。

## 4. 端到端验证(真实会话)

新开一个 Claude Code 会话(已在 cw-mem 工作目录下):

| 步骤 | 期望 |
|---|---|
| 会话启动 | `🧠 cw-mem 已生效` banner;若有历史则注入"过往会话摘要" |
| 发一个 prompt | UserPromptSubmit 注入"相关过往工作"(若 ollama+历史就绪);UI 出现 PROMPT 卡片 |
| 用一个工具(如 Bash) | (toolSummary 开启时)TOOL 卡片出现,显示 `↳ 归属提示词 #N` 链接 |
| 停止响应 | PROMPT 卡片出现"结果摘要";状态 success |
| 退出会话 | session_summaries 出现会话级摘要;`~/.cw-mem/cw-mem.db` 有向量 |

检查数据:

```bash
ls ~/.cw-mem/                          # config.json / cw-mem.db / 日志
node -e "const Database=require('better-sqlite3');const db=new Database(require('os').homedir()+'/.cw-mem/cw-mem.db');console.log('prompts:',db.prepare('SELECT COUNT(*) c FROM prompts').get().c,'memories:',db.prepare('SELECT COUNT(*) c FROM memories_meta').get().c,'session_summaries:',db.prepare('SELECT COUNT(*) c FROM session_summaries').get().c)"
```

## 5. 更新验证

bump 版本后推送,在 Claude Code:

```
/plugin update
```

确认 `~/.claude/plugins/installed_plugins.json` 的 `lastUpdated` 变化,缓存目录出现新版本号。

## 闭环保证(已单测覆盖)

- **LLM/ollama 不可用**:摘要落 `failed_final`(不卡 pending),语义召回返回空文本+error(UI 不崩),记录与注入照常。
- **状态机**:`pending → generating → success / failed_pending_retry / failed_final`,重试定时器按 `maxRetries` 接管。
- **维度变更**:改 `ollama.embedDim` 后需"保存并重启"重建 `memories_vec`(启动时探测并告警)。

# Evolution

随版本自动清洗旧数据。mica 的持久化形态一直在变，运行时代码按要求**不为旧形态保留兼容
分支**——旧数据由这个插件在升级后一次性就地改写成当前形态。

它解决的是一类重复出现的问题：某个字段是后加的（例如用量记录里的请求时间 `occurredAt`），
早先写下的数据没有它，新代码要么在每个读取点写一条兜底分支，要么把旧数据洗成新形态。
mica 选后者，这个插件就是「洗」的地方。

## 什么时候跑

- **每次宿主启动跑一次**：setup 之后立刻开始。会话目录只是 stat 一遍（按文件签名跳过没变过的），
  真正要改写的是升级之后那一批。
- 上一轮还有没处理完的会话（有宿主正在跑轮次、超过单轮上限）时 5 秒后续跑，最多 12 轮；
  洗完就停，这个进程里不再有第二次定时扫描。
- 为什么不做常驻轮询：一个开着好几天的窗口会定期重扫会话目录，而这些会话早已由宿主按当前
  形态写过；更糟的是它会在别的宿主读着同一条会话时改写文件——迁移结果会被那份内存快照
  覆盖回去，下一轮又迁一次，大文件反复整写。
- 只在常驻会话宿主里跑（TUI / `mica app-server`）。`mica exec` 是一次性运行，不改写数据。
- 每台机器各跑自己那份：账本在 `$MICA_HOME/plugin-data/evolution/`，不依赖任何远端，
  所以另一台装着 mica 的机器不会因为这边已经洗过而被跳过。

## 怎么跑

- 只处理**变过的文件**：账本按文件签名（size + mtime）记，日常一轮只是 stat 几百个文件，
  不解析会话内容。
- 拿到该会话的 **turn lease** 才动文件：正在跑轮次的会话留给下一轮，绝不和正在写它的进程抢。
- 单轮有时间与数量上限（默认 400 个文件），每 15ms 让出一次事件循环，界面不会被清洗拖卡。
- 写回走临时文件 + 原子重命名，不会留下半截文件。
- **默认不备份**。整份拷贝会让会话目录翻倍（实测 713MB 备份 / 599MB 会话），而迁移是幂等
  的纯函数、有单测兜底。要回滚某次改动时把设置项 `backup` 打开：改动前会拷到
  `plugin-data/evolution/backups/<sessionId>.json`（只留首次快照，保留 7 天）。

## 迁移规则

两类：**会话快照**（上面 `run.ts` 扫的那些 JSON）与**其它数据**（插件自己的文件、config.json）。
数据迁移每次启动都跑一遍——它们只读一两个小文件，幂等，代价可以忽略；会话迁移按文件签名
记账，变过才重读。

### 会话

| id                       | 内容                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `usage-occurred-at`      | 给没有请求时间的用量记录补上 `occurredAt`：主对话取会话创建时间，子代理 / 插件请求取任务开始时间；统计读取不再按会话或任务日期回退。                                                     |
| `session-compact-rename` | 清掉旧压缩插件（`auto-compact`）留下的会话状态，并把摘要子代理的旧写法 `subagentType: 'auto-compact'` 归一为 `compact`。                               |
| `drop-raw-usage`         | 删掉会话里存着的 provider 原始 usage（`rawUsage`，含 `attribution.items` 逐条 token 归因）：没有消费方，单条可达 247KB、实测占会话文件总量的 22%。     |
| `usage-source-owner`     | 给没有归属的用量记录补上发起它的插件：委派（内置子代理类型）→ `subagent`，`btw` / `commit` / `memory-curator` → 各自插件；`compact` 是内核命令，不动。 |
| `generation-timing-v2`   | 将没有 `generationOutputTokens` 的旧 `generationDurationMs` 归档为 `legacyGenerationDurationMs`；旧形态不再参与生成速率统计，token 用量与响应等待不变。 |
| `quick-buttons-accent-color` | 只为会话 `snapshot.pluginState['quick-buttons'].buttons` 中缺失的 `style.color` 补 `accent`；已有颜色、图标、形状、纯图标配置与按钮内容、动作和顺序保持不变，其它插件不受影响。 |
| `pi-messages-v1` | 将旧 Chat Completions / Responses 原生历史转换为完整 pi `Message[]`，写入 `snapshot.messageFormat: 'pi-ai-v1'`。身份由快照 provider/model/协议决定；保留正文、内联图片、reasoning 原项签名、工具调用与结果，展示对话及用量账本保留。已标记的快照不再改写。 |
| `notebook-mcp` | 将旧 `notebook_read` / `notebook_write` 工具停用项迁为 `mica-plugin-notebook` MCP 停用项；移除已撤下的 `notebook` skill 选择，其它能力与会话内容不动。 |
| `notebook-http-api` | Notebook 改为独立 HTTP API 后，移除上一步迁移留下的 `mica-plugin-notebook` MCP 停用项；保留其它 MCP 停用项。 |
| `session-turn-state` | 给缺失或非法的会话顶层 `turnState` 补为 `completed`；当前桌面读取只把剩余异常当作损坏数据处理，不再把缺失字段当作旧版本能力。 |

`pi-messages-v1` 只读文档本身：内联图片保留数据与 MIME，远程图片 URL / 文件引用保留为 `[Image](引用)` 文本（pi 图片块只支持内联数据）。Responses reasoning 的完整原项保存到 `thinkingSignature`，正文项的 id / phase 保存到 `textSignature`，函数调用与结果共享 pi 的 `call_id|item_id`。缺失的时间取会话创建时间，缺失的用量填零；现有用量记录的 token 数映射到消息内的 pi usage，不改原账本。无法识别的消息会使该文件转换失败，保留原文，不会把半份历史标成 pi。运行时不再支持旧 wire 历史，必须先经此迁移。

### 其它数据

| id                              | 内容                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory-scopes`                 | 把旧布局的记忆（`USER.md` / `MEMORY.md` / `projects/<cwd 哈希>/MEMORY.md`）并入 `PROFILE.md` 与同名项目记忆文件。                                                                                                                                                                                                                                                               |
| `session-tags-slots`            | 清掉标签表里没用过的旧固定色槽（只剩它们时换成「待 review」），并收敛指向已删标签的归属。                                                                                                                                                                                                                                                                                       |
| `config-model-discovery`        | 删掉 config.json 里已无消费方的 `get_model_url` 与空的默认模型（回落到第一个服务商的模型）。                                                                                                                                                                                                                                                                                    |
| `browser-cookie-sync-extension` | 将识别出的 v1 Chrome 数据库 / 手动同步设置与状态改名归档为同目录 `*.legacy-v1.json`；已有归档保留并使用编号后缀。新版 `target` 连接对象与未知状态字段保留，token 与扩展目录不动；损坏或无法识别的文件不改，旧形态不再支持。                                                                                                                                                     |
| `harness-review-assessments`    | 将 `plugin-data/harness-review/decisions/<key>.json` 的合法旧人工决策迁入 `<key>/legacy-<digest>.json`，补 `version: 1` 与 `baseline: null`（观测范围未知），保留 id、status、note、updatedAt；已有同内容历史不重复。原文件改名归档为 `*.legacy-v1.json`，已有归档保留并使用编号后缀；未知、损坏、键不匹配或非法路径不动。运行期不再支持旧单文件形态，需运行 `/evolution run`。 |
| `plugin-events-identity-v2` | 将 `plugin-data/harness-review/plugin-events.jsonl` 与 `.1.jsonl` 的旧失败行补为 `schemaVersion: 2`；合法已有 `pluginVersion/pid/generation` 保留，缺失或非法身份明确为 `unknown/null/unknown`，绝不从当前清单或进程猜历史身份。与生产者共用 `plugin-events.lock`，原始字节私有归档到 `legacy-plugin-events/` 后以 0600 原子替换；旧无版本形态不再支持。 |
| `plugin-startup-health` | 将旧 `plugin-health/<id>.json` 中宿主写下的「启动失败：…」错误原文归档到 `plugin-data/evolution/legacy-plugin-health/`，不再当作当前运行健康。只识别明确的旧启动错误，真实运行错误、成功记录与损坏文件不动；装配结论由当前宿主的 `plugin-status.json` 负责。 |
| `plugin-health-issues-v2` | 将旧单条健康状态迁为 `schemaVersion: 2` 的 `issues` 映射：业务状态放 `runtime`，明确的模型降级放 `llm:degraded`；所有原字段随报告保留，替换前完整原文归档到 `plugin-data/evolution/legacy-plugin-health/`。迁移与运行健康写入使用同一跨进程锁；当前形态、损坏内容与符号链接不改。运行时不再解析旧单条形态。 |
| `plugin-health-runtime-history` | 在上条之后，将 Memory / Web Search / Mobile Relay / Video / Computer Use / Reply Digest / Session Rename / Compact / Tags / Todo / Browser Cookie Sync / Evolution 已改用明确 issueKey 的旧 `runtime` 槽从活动文档移出。冻结的官方插件范围内，明确的旧 manager 后台 / hook / skill / 清单配置与角色故障也归档；其它业务 `runtime` 与用户插件任意健康不动。锁内读取最新原文，0600 归档到 `legacy-plugin-health-runtime/`，只删目标槽、保留其它 issue；历史归档不代表已恢复。 |
| `ssh-audit-v2` | 将 `plugin-data/ssh/audit.jsonl` 的旧行按固定字段白名单转换为 `schemaVersion: 2`：`script` 仅保留首个物理行的 SHA-256、任意原始 note 改为 `diagnostic_omitted`，固定备注码与安全生成日志路径保留；原有事件时间、退出码、耗时和结果不补造。与 append/trim 共用 `audit.lock`，原文 0600 归档到 `legacy-ssh-audit/` 后原子替换；运行期只认合法 v2，不再解释旧脚本行。 |
| `subagent-task-files` | 将 `subagent-tasks/<sessionId>.json` 的旧任务数组拆为 `<sessionId>/<taskId>.json`，已有独立任务更新优先；完整原文件改名归档为 `*.legacy-v1.json`，归档重名时加编号。损坏、未知数据与符号链接不改。运行时不再读取旧数组，需经此迁移。 |
| `notebook-comments` | 评论功能移除后，笔记文档里的 `comments` 讨论记录先归档到 `plugin-data/evolution/legacy-notebook-comments/<noteId>.json`（重名加编号），再删掉该字段；正文里由评论产生的 MarkNode 锚点拆回普通子节点，文字与格式不变。文档只剩 `version` 与 `editorState`，损坏文档与非 `version: 1` 文档不动；重复执行改动数为 0。 |
| `notebook-component-blocks` | React + Arco 交互块从 HTML 节点拆成独立的 `component` 节点：`type: 'html'` + `runtime: 'react'` 改写为 `type: 'component'`，源码字段 `html` 改名为 `code`；`runtime: 'html'` 的静态块只删掉 `runtime`。高度、格式与源码原样保留，损坏文档与非 `version: 1` 文档不动；重复执行改动数为 0，运行时不再认 `runtime` 字段。 |
| `notebook-mcp` | 将 Notebook 旧插件 skill 索引移到 `plugin-data/evolution/legacy-notebook-skill/` 原文归档，迁移默认能力中的旧工具停用项；不改笔记正文、用户手写 skill 或其它插件索引。旧 skill / 直连工具入口不再支持。 |
| `connections-peer-store` | 将 Connections 旧纯地址数组或缺 `version` 的 `{ peers }` 迁为 version 1 清单；原文归档到 `legacy-connections/` 后原子替换，运行时不再回写旧形态。 |
| `schedule-plans-stages` | 将 Schedule 旧 `plans/stages` 数据严格迁为扁平 `tasks`；原文归档到 `legacy-schedule/` 后原子替换，损坏或无法安全转换时不改原文件，运行时不再读取旧形态。 |
| `prompt-contributions` | 历史回查控制从 `plugin:builtin.command-memory/guidance` 迁到 `plugin:memory/history`，保留正文、开关与顺序，已有新控制优先；撤下 Todo / 会话自治 / Video / Web Search 的静态段落前将原控制文件归档到 `legacy-prompt-controls/`。归档 Schedule 随包 skill 索引到 `legacy-schedule-skill/`，不改排期数据、用户 skill 或能力停用选择（同名用户 skill 可能仍存在）。旧入口不再支持。 |

| `floatingwindow-favorites`         | 给已有 Floating Window 数据补上 `favoriteUrls` 收藏集合和 `favicons` 图标集合。                                                                                                                 |
| `floatingwindow-icon-origins`      | 把 Floating Window 的 `favicons` 从按保存的地址存键改为按站点 origin 存键（同一站点的多个地址只留第一个图标）；最近访问 / 收藏里的地址本身不动，已是 origin 键时为 0 改动。                        |

新增一条迁移 = 在 `migrations.ts` 里加一个 `Migration`（`id`、`description`、纯函数 `apply`），
然后写进 `MIGRATIONS`。账本按 id 记进度，所以追加迁移会让所有会话重新评估一次；已经洗过的
数据改动数为 0，不会重复改写。

非会话数据放 `data/`：一条 `DataMigration`（`id`、`description`、`run({ home, log })`，返回改动的
对象数），然后写进 `data/index.ts` 的 `DATA_MIGRATIONS`。它们没有签名账本，所以必须**幂等**，
并把「已经是当前形态」判成 0。

Harness Review 的纯转换 `harnessReviewAssessmentV1` 放在 `migrations.ts`，但不登记到
会话 `MIGRATIONS`：决策是非会话插件数据，只由 `DATA_MIGRATIONS` 扫描，避免让全部会话
为无关数据重跑。旧决策没有记录观测范围，所以迁移只写 `baseline: null`，不从现有运行回填。

同样，`pluginHealthIssuesV2` 在 `migrations.ts` 登记纯转换，只由 `DATA_MIGRATIONS` 的
`plugin-health-issues-v2` 扫描非会话健康文件，不加入会话 `MIGRATIONS`。

失败流和 SSH 审计迁移只读完整的连续 JSONL：每文件最多 8 MiB、每行 64 KiB、最多 50,000 行，
不从文件尾截一段当成完整历史。超限、未知版本、损坏 / 不完整记录或符号链接保留整份输入，
忙锁本轮跳过；不会部分改写文件或编造缺失事件。原文按内容摘要命名私有归档（目录 0700、文件
0600），重试复用同内容归档、冲突则不覆盖；活动文件也以 0600 原子替换。

`plugin-health-runtime-history` 的归档表示 **unknown/history**：旧 `runtime` 将多个恢复边界混在
一起，无法可靠映射到新问题；从活动文档移出不是成功、恢复或验收证据。其它 issue 继续按原状态
显示；移出后没有活动 issue 时仅表示「当前没有已归属的报告」。不产生 `ok` 或伪造恢复时间。

规则只有三条，违反任何一条都会让「删除运行时兼容分支」变成一次数据事故：

1. **幂等**：第二次执行必须返回 0；
2. **不删除用户数据**：会话正文、用量数字（token / 金额）、备注、设置都只补字段或改名，绝不整体删掉；
   唯一可以整块删的是**没有消费方的 provider 原始响应体**（如 `drop-raw-usage` 删的 `rawUsage`）——
   它不属于用户数据，留着只会随着每次请求堆积。
3. **只看文档本身**：不依赖进程状态、网络或用户当前选择。

## 命令

| 命令             | 作用                               |
| ---------------- | ---------------------------------- |
| `/evolution`     | 上次检查时间、待清洗会话、迁移规则 |
| `/evolution run` | 立刻把所有会话的旧数据清洗一遍     |

## 设置

| 项        | 默认 | 作用                                                                |
| --------- | ---- | ------------------------------------------------------------------- |
| `enabled` | 开   | 关掉之后只有 `/evolution run` 会清洗                                |
| `backup`  | 关   | 改动前把会话文件整份拷到 `backups/`；会翻倍占用，只在需要回滚时打开 |

运行状态写在 `plugin-data/evolution/data.json`，配置页插件详情按清单 `status` 显示；
排查问题时插件日志在 `$MICA_HOME` 之外（见 `pluginLogPath`）。

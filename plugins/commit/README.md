# Git Commit（commit）

把当前工作区的改动变成一次提交：确定性分析 Git 变化 → 让模型写一条 commit message → `add -A` → `commit` → 可选 `push`。

- 官方插件，随 CLI / 桌面端一起编译，无需安装。
- TUI 里是 `/commit` 命令；`mica commit` 与桌面端右键「commit」也走同一个实现（一次性插件命令，不起 agent、不建会话）。
- 写说明的模型默认跟随主配置，也可以在配置页 **Plugins → Git Commit** 的「提交说明模型」面板里关掉「跟随主配置」、单独填接口地址 / Key / 协议 / 模型（比如换一个更便宜的小模型），填完点「测试连接」先确认能通。
- 停用该插件后，上述三条入口一起失效。

## 设置项

| 键         | 类型   | 说明                                                     |
| ---------- | ------ | -------------------------------------------------------- |
| `prompt`   | 长文本 | 生成提交说明的系统提示词，留空用内置默认值               |
| `push`     | 开关   | 提交成功后推送；没有上游时按同名远程分支推，都没有就只提交 |

模型接口由清单的 `llm` 声明生成（「提交说明模型」面板）：`useMainProvider`（跟随主配置）/
`baseUrl` / `apiKey` / `protocol` / `model`，见 `plugins/README.md` 的「模型接口」一节。
默认跟随主配置；填了自己的接口地址就用自己的地址，此时必须填模型。

设置落在 `$MICA_HOME/plugin-settings/commit.json`。

## 行为细节

- Git 部分完全确定：命令自己跑 `status` / `diff` / `add` / `commit` / `push`，模型只负责写那条说明。
- 先看 `git status --porcelain`：没有变化返回 `nothing_to_commit`，有未解决冲突返回 `unmerged`，都不碰模型。
- 摘要交给模型时还没 `git add`：未跟踪、已暂存、未暂存三类都看得到，模型不必猜测。
- 摘要按文件采样（单文件与整体都有字符预算），锁文件、`dist/`、快照等大而低信息量的改动只给 `--stat`。
- 模型请求交给宿主的 `ctx.models`：一次「system + user → 文本」，没有工具、没有多轮；协议分支、超时与用量记账只有一份实现。`mica commit` 里没有会话，只发请求、不记账。
- 模型那一步失败时工作区保持原样，用户还能重新挑文件提交。
- 提交用 `git commit -F`（临时文件传 message）：多行说明里的引号、`#`、空行不会被改写。
- 推送：有上游就 `git push`；没有上游但 origin 上有同名分支就补一次 upstream；两样都没有返回 `pushed: false`（不是失败）。
- 出错时用户看到的是命令结果的 `message` + 插件的健康状态；`/commit` 在 TUI 里运行中也能执行（`allowDuringTurn`），并发由 git 的索引锁兜住。

## 输出

TUI 的命令只用 `message` 说结果。`mica commit` 输出单行 JSON，桌面端按它渲染：

```json
{"ok":true,"commitHash":"1a2b3c4","subject":"feat: 开发了提交插件 ✨","commitMessage":"...","pushed":true}
{"ok":false,"code":"nothing_to_commit","error":"没有可提交的变化"}
```

失败时 `code` 取值 `nothing_to_commit` / `unmerged` / `nothing_staged` / `error`（后者是执行期抛错：模型请求或 git 命令失败）。

## 文件

```
plugin.json   清单：id / 版本 / 入口 / 配置项
index.ts      装配：/commit 命令、设置读取、健康状态与进度通知
flow.ts       一次提交流程：分析 → 模型 → add → commit → push
summary.ts    变更摘要：状态归类、按文件采样 diff、低信息量文件降级
message.ts    提示词、模型返回清洗、默认兜底文案
settings.ts   设置 → 请求参数（跟随主配置或独立接口）
git.ts        git 执行、冲突判定、`-F` 提交、推送
```

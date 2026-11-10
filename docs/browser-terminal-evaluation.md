# Browser / Terminal Control 实测评估

日期：2026-11-10。对象为 Mica 内置受控浏览器、终端控制及其 MCP / sidecar 接入链路。

## 结论与验证范围

基础能力可完成实际研究、站点搜索和开发者交互任务，但「工具存在」不等于端到端可靠：本轮发现并修复会话级 MCP 丢失、截图被文本化、软换行等待漏匹配、交互回显误删真实输出四类缺陷，同时纠正退出码与 idle 的说明。

**修复已在源码级验证，未构建、安装或重启用户当前 Mica。** 浏览器引擎复用运行实例的真实隐藏 Electron 窗口；MCP 门面和 Agent 使用源码。终端由源码服务启动真实 node-pty / 登录 shell，而非 mock 输出。当前运行实例仍有「同 owner 同模式最多一个窗口」的旧限制，源码已有多窗口实现；不能将源码的测试通过说成运行实例已生效。

没有测试真实账户登录、付款、生产数据写入、任意站点兼容性或长期资源压力，不据此给总体成功率或性能排名。

## 方法

1. 在当前安装版派出三个真实 sidecar 任务。它们全部缺少浏览器 / 终端 MCP，未执行控制动作，构成明确的接入阻断证据。
2. 主会话直接操作真实隐藏浏览器与 PTY，复现截图类型和长文本等待问题。
3. 最小修改后，通过修复后的 SidecarProcess 启动源码 app-server，继承父进程显式 MCP 配置，使用隔离 MICA_HOME 和用户已有 provider 做三个真实任务。
4. 根据真实终端任务暴露的交互回显问题继续修复，再做真实 PTY 与单独 Agent 定向复测。
5. 运行相关单测、typecheck、diff 检查。没有替换已安装 CLI 或桌面产物。

测试配置仅临时引用实际 provider 凭据，未输出 key、未改原配置；测试结束清理临时副本、PTY、窗口和服务进程。

## 真实任务结果

下表调用数以保存的 function_call 轨迹为准，含动作文档读取；耗时包含模型请求、工具、等待和恢复，不是工具本身延迟。

| 任务                                                        | 控制调用 | 模型请求 | 总耗时 | 实际结果                                                                                                                                            |
| ----------------------------------------------------------- | -------: | -------: | -----: | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 官方文档研究：Node.js child_process 与 Electron webContents |       16 |       17 |  64.0s | 两个标签页定向读原文；截图真正作为图片进入 provider，模型描述了 NOTE 框及灰色左边线；无失败调用                                                     |
| 面试题库：搜索 Context、替换为工具调用、打开稳定链接        |       23 |       24 |  88.0s | 输入 clear 替换成功、点击结果、新标签核对同题、滚动和默认截图成功；2 次窗口/标签失效错误后恢复                                                      |
| 开发者终端：Vitest、中文交互、resize、Ctrl+C、退出          |       20 |       21 |  82.5s | 2 文件 16 测试通过，命令退出码 0；stty 返回 16 64；Ctrl+C 后状态 130、shell 可继续；最后 shell 退出码 0；1 次回显误过滤超时后用 skipEcho:false 恢复 |
| 修复后中文交互定向复测                                      |       11 |       12 |  56.0s | 默认 skipEcho 下完整结果匹配，elapsedMs=0；专用 shell 退出与清理成功；另有 1 次 Agent 猜错提示符导致 15s 等待                                       |

有效任务合计 70 次控制调用、74 次模型请求。隔离测评的 provider 用量：输入 1,270,103 tokens，其中缓存输入 1,175,552（约 92.6%），非缓存输入 94,551；输出 7,172。这不含主会话、实现/审阅代理和第一轮三个受阻 sidecar 的用量；未按未知供应商价格估算金额。

研究来源为任务素材，不作为控制功能的通用保证：

- https://nodejs.org/api/child_process.html
- https://www.electronjs.org/docs/latest/api/web-contents#contentssendinputeventinputevent
- http://155.254.127.215/interview/?question=agent-context-engineering
- http://155.254.127.215/interview/?question=agent-function-calling-vs-json

## 已修复问题

### 1. sidecar 丢失会话级 MCP — 阻断

父桌面会话通过临时 --mcp-config 获得控制工具，sidecar 只继承环境、不继承 CLI 参数，因此三个真实任务全部无法开始。

修复在 plugins/sidecar/sidecarProcess.ts：继承显式配置、strict 和初始化超时；相对配置基于父启动目录固定，不受父之后换目录或子 cwd 影响。只引用原文件、沿用父 owner，不复制凭据、不自动创建新权限。

验证覆盖 split / equals、父子不同 cwd、父进程自身 chdir、真实子进程 argv，以及源码 Agent 实际控制任务。

### 2. 截图变成 base64 文本 — 阻断视觉理解

浏览器成功生成 PNG，MCP host 也能返回 image，但 mica-mcp 只收集 text，无 text 时 JSON.stringify(image content)，随后文本截断。真实截图约几十万字符，图片类型丢失，模型不能按图像理解。

修复 packages/mica-mcp/tools.ts：返回既有 ToolResult 图像块，支持混合图文、保持顺序；文本共享 60,000 字符预算，图片不经过文本截断。保留资源文本和链接；不支持的二进制只给短说明。中止、错误和重连语义保持。

修复 apps/desktop/src/host/control-mcp.js：浏览器 screenshot 的 MCP 调用默认 raw=true；显式 raw=false 与直接 HTTP 默认 JSON 契约保留。

两次真实任务都保存了 provider 原生 input_image，并给出与截图对应的视觉描述。

### 3. 软换行导致 wait 漏匹配 — 等待可靠性

64 列 PTY 输出完整长标记后，视觉文本中间插了换行，原 waitFor(text=完整标记)超时；长命令回显也无法正确过滤。

修复 terminal-core.js / terminal-sessions.js：仅按 xterm isWrapped 拼接软换行供 text/regex 匹配，保留真正换行及宽字符边界；回显过滤仅作用于内部匹配文本，返回 screen 不再被删行，视觉行与 cursor 始终一致。

真实 node-pty 验证：长文本/正则命中、输出前回显不命中、真实换行不产生伪命中、非零退出码正确返回。

### 4. 交互回显误删真实输出 — 5 秒假超时

真实任务输入「林 奇荣 qa smoke」，屏幕出现 RECEIVED=<林 奇荣 qa smoke>，默认过滤仍超时 5 秒；skipEcho:false 立即成功。旧算法倒序找任意包含输入的行，把最后的真实结果当成回显。

修复：写入前捕获逻辑输入行及历史命中上下文，定位该次回显，而不是删除任意包含输入的结果。无上下文的回退也收紧候选。覆盖带后缀/行尾/完全同文输出、重复命令、中文宽字符、窄列。

真实 node-pty 在 21 列下 53ms 命中；最后真实 Agent 默认 skipEcho 下 0ms 命中。

回显辨别仍是启发式，不是 shell 语义协议：复杂全屏 TUI 重绘、输出未解析时的输入、超过历史窗口的文本仍需结合读屏判断，skipEcho:false 作为显式逃生口保留。

### 5. 等待语义说明

expectExitCode 等待整个 PTY/shell 进程退出，不表示持久 shell 内任意命令的退出码。idle 只表示静默，失败、交互等待、长时间计算同样可能 idle。

文档改为：持续 shell 在命令后立即捕获 $?，输出每次唯一的完成标记；专用终端才允许以该状态退出 shell，再等 expectExitCode。真实任务分别验证了测试命令 0、Ctrl+C 130 和最后 shell 0。

## 剩余优化空间与优先级

### P1：独立控制资源，不共享清理生命周期

并行浏览器任务沿用父 owner，而当前运行版限制同模式一个窗口：一个任务被迫在另一个窗口开 tab，窗口创建者收工关闭窗口时，另一个任务的 tab 一起消失。源码已有每 owner 最多 8 窗口的实现及服务层测试，本轮未重启验证真实多窗口并行。

合理约束是各任务创建自己的窗口、只清理自己的窗口/标签；重用别人的窗口时只关自己创建的 tab。将来若需要任务级 owner，需要明确它与主会话顶栏归属的映射，不能简单随机 owner 让用户看不到窗口。

### P2：浏览器元素发现与读屏成本

真实 SPA 搜索需 evaluate 先读 input/link 选择器，再 type/click，再读状态；可考虑紧凑的交互元素快照（role、name、selector、可见/禁用状态），减少每次现写 DOM 提取和整页文本。不应直接加一份庞大 HTML。

### P2：更可靠的 shell 就绪与命令完成

最后任务猜测提示符为 [%#$] 而实际是带箭头的 zsh 主题，白等 15s。就绪判定不要绑定提示符字符；先 idle 后读屏，比猜一个通用 regex 更好。若增加 runCommand/完成句柄，应建立在明确 shell 协议上，不能把静默等同成功，也不能破坏交互程序。

### P2：减少工具轮次与重复输出

本轮每条真实任务的模型请求数基本是控制调用数+1，说明工具往返而非页面操作占明显成本。稳定连续步骤可以考虑有序动作批次：第一步失败即停，返回每步状态；不等同跨 tab 无序并发。

动作文档是一次性完整目录（浏览器约 17k 字符），历史工具结果压缩到 12k 后后半段丢失。可考虑按 action 查询和短摘要；终端响应也同时返回 text/lines 及部分重复 cursor/inputLine，可增可选紧凑模式，但不直接删现有契约。

## 自动验证

最接近改动的验证合计 200 项通过，未跑全仓全量：

- sidecar process + lifecycle：25。
- MCP proxy results：17。
- control MCP + browser docs：35。
- browser service：24。
- terminal core + sessions：62；terminal docs + service：21。
- 真实终端任务中的配置页 browserControl / terminalControl：16。
- bun run typecheck：通过。
- git diff --check：通过。

命令：

```sh
bun run test:unit -- plugins/sidecar/sidecarProcess.test.ts plugins/sidecar/lifecycle.test.ts packages/mica-mcp/tools.test.ts
cd apps/desktop
bun test --timeout=20000 src/host/control-mcp.test.js src/main/browser/browser-docs.test.js src/main/browser/browser-service.test.js
bun test --timeout=20000 src/main/terminal/terminal-core.test.js src/main/terminal/terminal-sessions.test.js src/main/terminal/terminal-docs.test.js src/main/terminal/terminal-service.test.js
cd ../..
bun run typecheck
git diff --check
```

真实任务复跑需要独立 MICA_HOME、源码 app-server、带父 owner 的显式 MCP 配置，以及实际 Electron 浏览器服务。仅使用用户授权 provider，不打印 key；用后关闭自己创建的资源和临时配置。不要为了加载修复而中断用户的运行实例。

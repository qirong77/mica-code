# 近期提交审查（2026-11-04—2026-11-05）

## 范围与限制

- 审查基线：`9832dba8..58d1da4e`，两天累计涉及 546 个文件。重点沿压缩/存储、插件能力面、桌面面板、浏览器与工具生命周期追踪调用链，并非对全部变更逐行作出无缺陷保证。
- 同时核对当前工作区，排除已经由未提交改动修复的问题。工作区原有多批修改，Harness Review / Evolution 另有并发会话负责，未将其算作本次修复。
- 未提交、构建、重启、部署；未修改用户真实会话、配置或凭据，也未执行凭据探针。

## 已修复

| 优先级 | 问题与触发条件 | 修复位置与策略 |
| --- | --- | --- |
| P1 | 尚未发布索引的插件角色在 Controller 恢复时被旧 fallback 永久改成 default | `apps/cli/src/session/SessionController.ts`：保留非空角色名，正文 fallback 留给 AgentRuntime |
| P1 | 运行中拖拽会话层级无锁整文件替换；身份比较不是跨进程 CAS，可能覆盖宿主新对话 | `apps/desktop/src/host/session-parent.js`：删除无锁重试路径，持有 turn lease 时拒绝，提示本轮结束后再操作 |
| P1 | computer_use 的 spawnSync 阻塞宿主，无法及时接收停止请求，后续键鼠步骤可能继续运行 | `plugins/computer-use/Tool.ts`：异步子进程、中止/超时、输出上限、进程组终止、许可清理 |
| P2 | 连续两次 turn 重试会丢掉上一轮尚未重放的 after_iteration 输入 | `HeadlessTurnExecutor.ts`：将已消费项前置于未消费尾部，三次尝试回归验证 A/B 都保留 |
| P2 | 面板缓存身份不完整，fresh view 不更新未编辑草稿；跨分区 edit 无法正确回填 | `PluginPanels.jsx`、`plugin-panels.js`：统一 node/session/cwd/role 身份，三方字段合并，共享预热视图 |
| P2 | 自动提交 busy 时直接丢弃；关闭或切分区会丢最后一段输入 | 同上：串行队列，每分区保留最新待交值，关闭/切分区补交，显式动作废弃旧待交项 |
| P1 | 面板编辑器超长正文静默截断后仍允许写回；空字符串 text 被丢弃 | `packages/mica-plugin/PluginPanel.ts` 与 renderer：超限读取只读告知、提交拒绝、草稿保留、空串有效 |
| P2 | 快捷按钮仍每次创建浏览器窗口，与每会话单窗口限制冲突，第二次打开降级到系统浏览器 | `plugins/quick-buttons/browser.ts`：按 owner 复用窗口建标签，409 后重查 |
| P2 | Git 比较缓存遗漏 head；相同文本、不同 blame 元数据仍复用旧提交 | `git-diff-session.js`：缓存键含目标 head，blame 身份变化时重建绑定 |

## 压缩判断更正

此前列出的“空闲模型压缩覆盖原始展示历史”和“摘要后固定展示前缀避免 notice / 新消息问题”两项是错误判断，现已撤销对应的原始展示历史保留逻辑及其测试，不再列为已修复。用户要求对话框忠实、完整展示当前持久化记录，而不是保留一份永不随压缩变化的原始历史。手动 quick / model 与轮前 `compactHistory` 都应将当前压缩结果落盘并同步展示；`turn:prepare` 接口与切模型后的快速压缩触发保留。上表其余 9 类修复保留。

## 清理

- 删除无生产引用的一次性探针 `.probe-hidden-browser.mjs`、`.probe-quota.py`、`.probe-usage.py`。后两者含读取本机认证配置的逻辑，未执行。
- 删除运行中调整层级的伪 CAS 分支、角色解析上层的旧名称回退、桌面工具同步子进程路径、编辑器静默裁剪写回路径。
- 同步相关架构、插件与公共包说明；本轮纠正此前误加的“压缩只改 provider、完整展示历史永久保留”表述，明确展示与当前持久化压缩记录一致。
- 没有批量清空旧会话或删除备份；本轮更正不迁移用户数据。

## 尚未修复的高风险项

### P1：迟到插件用量仍可能无租约保存旧内存快照

位置：`apps/cli/src/session/SessionController.ts` 的 `recordSubagentUsageForSession`。

进程 A 恢复会话并发起后台模型请求，等待期间进程 B 完成新轮次，A 的请求完成且自己 idle 时会调用 `saveCurrent`，存在用旧历史覆盖 B 新历史的窗口。非当前会话的 load/save 也缺少租约保护。

本次尝试了持久 pending journal，但复核发现其会改变 rewind 的用量恢复语义，直接读 JSON 的 Stats 无法观察未物化记录，且未统一取得租约的 rename/rewind 写入仍可与 flush 竞争。因此已精确撤除这部分试验，没有交付一套不闭环的新格式。

建议下一次集中统一会话写入事务：turn、idle maintenance、rename、rewind、插件状态与辅助用量共同使用明确的租约所有权；再实现窄更新或可恢复用量队列。若新增持久化布局，需同步 Evolution、统计读取与崩溃恢复测试，不用同 PID 或 isRunning 冒充锁归属。

## 后续架构清理建议

- `packages/mica-session/sessionStore.ts` 的 `readForUsage` 仍保留旧会话格式的统计专用解析；应先为确实仍需保留的数据设计一次性 Evolution 转换，再删除运行期旧格式分支，不能直接删读法让历史费用消失。
- `agent/desktop.md` 仍记录旧 `workspace.json` 向 `ui-state.json` 的运行期导入。清理前需确认 Electron userData 路径如何交给 Evolution，避免把一次性迁移再复制到另一个宿主。
- 这两项未在本次大范围修改持久化布局，避免与正在修改 Evolution 的会话竞争。

## 验证边界

本轮纠正：压缩、headless 宿主、turn executor 与 notice 的 4 份针对性测试共 65 项通过；`bun run typecheck`、`git diff --check` 通过。已确认压缩实现、宿主 composer 与 notice 实现不再含本次审查加入的冻结展示历史逻辑。未构建、未重启。

此前报告针对修改处的 12 份测试文件共 289 项测试通过（各文件取当时最终一次结果，不重复累计），以及 `bun run typecheck`、`git diff --check` 通过。这是包含现已撤销压缩逻辑及测试的历史验证结果，不代表本轮撤销后的最新验证；本轮验证须另行报告。此前同时确认试验性 journal 无剩余 diff 或调用残留、仓库根无 `.probe-*` 文件。桌面操作测试使用无桌面副作用的 stub runtime；浏览器复用使用 HTTP stub，未发出真实键鼠事件、未打开真实窗口。未运行全量测试、全量 lint 或真实子进程 E2E。

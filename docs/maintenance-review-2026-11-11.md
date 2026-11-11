# 整体维护审查与修复（2026-11-11）

审查起点：`bcd566c9`。重点沿近期 pi-ai 迁移、共享编辑器与 Notebook、桌面摘要/文件/Git、会话持久化和测试入口追踪真实调用链。改动直接留在当前工作区，未提交、构建、安装或重启用户应用。

## 已修复的问题

| 领域              | 触发条件与影响                                                                                                | 修复                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话后台记账      | 插件请求完成时，idle 宿主用旧内存快照完整保存，可能覆盖另一进程的新回答或回退结果；非当前会话也曾无租约读改写 | Controller 显式登记租约句柄；写入前等待合法租约并读取最新磁盘快照，只追加发起会话的用量。保留回退语义，已删除会话不重建，新草稿的真实用量不作为空草稿丢弃 |
| 租约失效与删除    | 旧句柄只凭内存登记可误借用已被新 token 替换的锁，删除还可能清除活跃 writer 的锁                               | `isHeld()` 按磁盘 token 验证；Controller 清理失效登记；删除先取得同一租约，拿不到即拒绝，所有路径释放自身句柄                                             |
| 模型工具开关      | `tools: false` 只省略工具声明，模型仍返回调用时会执行工具                                                     | 在执行前拒绝工具调用，保留该响应已报告的用量                                                                                                              |
| 网关重试          | 顶层 `code` / `type` 在错误正文转换时丢失，`request_read_error` 等错误无法正确重试                            | 将结构化错误码和类型与正文一起交给 SDK，补真实本地 HTTP/SSE 回归                                                                                          |
| 客户端协议切换    | app-server 还按旧 wire 格式拒绝现有会话跨协议切换，底层 pi 历史实际已支持                                     | 删除两处遗留限制，保留模型/provider/busy 校验；真实常驻宿主验证 Responses → Chat → Responses、未显式选模型的继续轮次及新宿主恢复                          |
| 图片预算          | 递归扫描旧 wire 形态，会把工具参数中同形的 `{ type: 'image', data: ... }` 当成图片替换                        | 只处理 pi user/toolResult 的实际图片块，参数和签名保持原样                                                                                                |
| Git 单文件操作    | `group[1].txt` 被当作 pathspec，暂存、取消暂存、回退可能操作 `group1.txt` 等其它文件                          | 统一使用 literal pathspec，覆盖正常及无首个提交的仓库                                                                                                     |
| Git 路径校验      | 合法的 `..config` 等文件名被误判为越界                                                                        | 按完整父目录段判断，继续拒绝真正的仓库外路径                                                                                                              |
| 会话读取缓存      | 文件已更新时新请求仍加入旧 Worker，旧读取还可能回填缓存或清掉替代请求                                         | 在途读取绑定文件签名；回填检查请求身份与磁盘签名                                                                                                          |
| 摘要通知          | `replace` 删除旧通知后序号前移，可能覆盖其它通知或复用存活行的 React key                                      | 先处理替换并校正剩余通知序号；新增行分配无冲突 ID，存活行保持原身份，重复重放不移动行                                                                     |
| 自动摘要          | 最新用户输入之后没有正文时，会越过该输入重复摘要上一轮回答                                                    | 摘要只取当前回合正文；已满足字符阈值时跳过整篇分行统计                                                                                                    |
| Todo 恢复         | 带图片的新用户消息被旧协议判断当作工具续行，恢复上一轮 Todo                                                   | 按当前 pi `user` / `toolResult` 角色语义划定计划范围，删除旧 wire 判断                                                                                    |
| Markdown 换行符   | LF 编辑器输出写入 CRLF Monaco model，内容未变也产生编辑并重新标 dirty                                         | 比较增量前按 model 换行符归一化，保留原文件换行格式                                                                                                       |
| 编辑器消息        | 同一文档重载或快速切换时，迟到 change/save/outline/flush 可能属于旧加载                                       | Markdown 与 Notebook 桥按加载身份验证消息，加载确认前不接受正文，过期请求明确拒绝                                                                         |
| Notebook 保存     | 自动保存、切换和关闭并发写同一 CAS 版本，可能冲突或遗漏写入中的尾部输入                                       | 共用串行写入队列，推进实际保存版本并继续保存新输入，失败保留草稿                                                                                          |
| Notebook 保存失败 | 保存 B 期间撤销回已保存的 A，B 已落盘但回包失败后，A 可能被误判 clean                                         | 显式记录未确认基线，后续 flush 不因等于旧 saved 就清除 dirty；确认保存或显式重载后才能恢复可信基线                                                        |
| Notebook 关闭     | 关闭等待目录保存时仍可切换并解冻新笔记，卸载会遗漏 iframe 队列中的尾部输入                                    | 统一关闭与文档替换边界：关闭先冻结，阻止新切换，等待已在途替换后再 flush；失败才恢复编辑                                                                  |
| 首次迁移恢复      | 宿主先恢复空任务集，Evolution 随后生成新任务文件，却因没有 restored 条目而不再刷新                            | 空集也检查目录指纹，变化后读取；切换会话清掉指纹缓存，保留当前执行句柄                                                                                    |

关键源码与回归入口：

- 后台记账：[SessionController](../apps/cli/src/session/SessionController.ts)、[租约与迟到用量回归](../apps/cli/src/session/SessionController.usage.test.ts)、[模型请求记账](../apps/cli/src/plugins/pluginModels.ts)。
- Provider：[PiModelClient](../packages/mica-agent/providers/PiModelClient.ts)、[图片预算](../packages/mica-agent/providers/imageBudget.ts)、[网关错误正文](../packages/mica-agent/providers/providerErrorBody.ts)。
- 桌面：[Git 操作](../apps/desktop/src/host/git-ops.js)、[会话读取](../apps/desktop/src/host/session-reader.js)、[通知投影](../apps/desktop/src/renderer/src/chat-notices.js)、[文件模型](../apps/desktop/src/renderer/src/files-document.js)。
- 编辑器：[Markdown 桥](../packages/mica-editor/web/bridge.ts)、[Notebook 桥](../plugins/notebook/bridge.ts)、[保存队列](../plugins/notebook/writer.ts)、[插件文档存储](../apps/desktop/src/host/plugin-data-store.js)。

## 冗余代码、兼容分支与文档

- 图片预算收敛到 pi 消息，删除旧 Chat/Responses wire 分支及无调用的 `imagePlaceholder`、`interruptedToolOutput`。
- 子代理运行时不再探测或读取旧会话级任务数组。新增 Evolution `subagent-task-files`：拆成独立任务文件，保留已有更新，归档完整原文；损坏或无法识别的数据不覆盖。迁移覆盖幂等、重复 id、部分完成、归档重名与符号链接边界。
- 删除共享编辑器中确认无引用的 Playground 设置、演示动作、录制、性能显示、旧表格菜单、重复大纲及其配套样式/辅助模块，移除相应未使用依赖。
- Desktop README 从 800 余行收敛为启动、测试、构建、源码导航与诊断入口。主题、协议、访问边界、插件 API 等细节链接到当前维护文档，避免继续保留互相矛盾的实现描述。
- 官网工作流改为当前 Session Compact 行为，纠正“模型压缩后仍保留完整原始对话”和已移除的自动阈值/空闲压缩设置。
- 历史评审移至 [archive/](./archive/README.md)，保留原证据并标明适用时期；旧高风险项补后续修复状态。

## 性能与测试架构

- 图片预算不再递归重写全部历史对象；只复制真正需要替换的图片所在消息，减少不必要分配。
- 长回复已满足摘要字符阈值时不再拆分全文计算行数。
- 插件文档写入直接计算返回实际写入内容的版本，Notebook 自动保存不再为确认版本重读并传输整篇正文。
- 插件前端目录索引延迟到实际需要加载器时创建，导入聊天辅助逻辑不再执行 Vite 宏；已用 Vite 实际 transform 确认 Notebook 等随包加载器仍存在。
- Desktop 测试父进程在启动 Bun 前隔离 Git 配置和 PATH。实际复现了 Bun 并行 worker 的 preload 环境修改无法进入默认子进程的问题；修复后不再运行开发机 Git hooks。
- Desktop 测试统一使用根依赖中的真实 React/React DOM，与 Vite dedupe 对齐，解决跨包 server-render 测试的 invalid hook call。
- 修正根测试中的旧协议字段、插件清单字段、Arco Input 回调和终态任务投影断言；Git 测试使用真实路径，覆盖 macOS `/var` 与 `/private/var` 及符号链接别名。
- MCP 子进程测试以受控初始化验证事件顺序，移除依赖机器负载的固定毫秒差；任务恢复通过 detail 验证，不等待只展示活动任务的 dock 通知。
- 主流程夹具停用另有独立回归的标题与回复摘要插件，避免辅助请求与主请求争用“最后一次请求”断言；BTW PTY 等待 runtime 完成启动后才输入，最终流程验证将 PTY 指向当前源码启动器，未复用旧构建产物。

## 验证记录

以下记录只计各套件最终结果，针对性复验不重复累加。

| 验证                    | 结果                                                                        |
| ----------------------- | --------------------------------------------------------------------------- |
| 根 TypeScript           | 通过                                                                        |
| 根 Vitest unit          | 357 个文件通过，3,976 项通过，4 项按原有条件跳过                            |
| 根 Vitest process       | 全组 125 项通过；PTY 启动检测修正后另 1 项定点复测通过；10 项按原有条件跳过 |
| Desktop Bun             | 228 个文件，2,388 项通过，0 失败                                            |
| 独立编辑器 runtime      | 14 个文件，377 项通过，独立 TypeScript 通过                                 |
| 官网 Astro check        | 27 个文件，0 errors、0 warnings，2 个现有 keyCode 弃用提示                  |
| Vite 插件目录 transform | 通过，宏被正常转换且保留 Notebook loader                                    |
| 文档本地链接            | 已检查当前整理的 6 份文档，无失效目标                                       |
| `git diff --check`      | 交付前最终检查通过                                                          |

流程组最后一次全组执行有 125 项通过、1 项 PTY 启动检测失败；修正 PTY 就绪和输入稳定检测后，该项在当前源码启动器下独立复测通过（6.79 秒）。因此流程用例最终结果合并为 126 项通过、10 项跳过，不把定点复测冒充修正后再次全组执行。

Provider 与流程测试使用本地 mock HTTP/SSE、隔离 MICA_HOME、真实 Node/Bun 子进程、临时 Git 仓库及 PTY。没有调用真实计费模型或修改真实用户会话。桌面渲染测试与 Monaco 实际文本缓冲已覆盖相关逻辑；本轮没有启动当前应用做交互验收，也没有 Windows 真机验证。

## 交付与剩余边界

- 修改尚未提交、构建、安装或重启。现有运行实例继续使用此前产物；源码修复需在后续构建中进入应用。
- 编辑器第三方依赖仍按既定设计从固定版本 CDN 加载；离线时 Markdown 保留源码降级入口。
- 后台用量等待其它写入者的租约释放，不用无锁写入或新 journal 绕过互斥；进程在等待期间被强制终止仍无法保证尚未追加的请求用量落盘。
- 第二轮独立复审确认并补齐了首次迁移刷新、通知行 ID、未确认保存和关闭切换边界；最终定点复审未发现上述序列仍有阻断问题。该结论限定于已审查与验证的范围。

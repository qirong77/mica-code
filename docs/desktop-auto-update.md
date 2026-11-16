# Mica 桌面端更新

## 点击后会发生什么

- 页面每 10 分钟检查一次当前运行时对应的 `main`；原生更新源也会定期检查，从后台切回前台还会补查。源码有新提交时，底部左侧显示「有新提交」。**新提交不等于该平台的安装包已经发布**。
- 只有带正式更新元数据的 Electron 安装包才会进入下载流程。本机 `build:app` / `pack:app` 是 `electron-builder --dir` 目录包，不保证 `Resources/app-update.yml`，不能当作正式可自更新安装包；这类包只显示模式说明与官方 Release 链接。
- 下载完成显示「重启更新」。后台检查、窗口切换或打开另一窗口，不会把已下载状态改回「有新版本」，也不会自动安装。
- 源码 / 开发模式、普通浏览器，以及连接另一台运行时的窗口，只展示版本信息和可点击的更新链接；不执行 `git pull`、覆盖源码或重启远程服务。没有平台包、IPC 被拒绝或网络失败时，页面明确说明原因，不能静默结束。

## 运行中工作的保护

下载不需要停下会话。**真正安装前**，主进程检查本机运行时和原生窗口，不依赖当前页签的一颗「运行中」圆点。

以下情况会拦住安装，并保留已经下载的包：

- 任一会话仍在执行，包括维护 / 压缩、中止中的轮次、排队消息、BTW、未完成的请求，以及父轮次结束后仍在运行的后台 shell、子代理、等待任务；
- 还有提交任务，或相同 `MICA_HOME` 中另一 Mica / TUI 进程持有活跃 turn lease；
- 普通终端或受控终端仍打开（包括空闲 shell，因为它可能有后台作业）；
- 受控浏览器、独立编辑器窗口仍打开；
- 本机主窗口中有未保存、正在保存或正在加载的文件。

此时只提示具体阻塞原因，**不停止任务、不发中断信号，也不预约稍后自动重启**。任务结束或保存并关闭相关窗口后，用户再次点击「重启更新」。

完全空闲后弹出原生确认框，默认选「取消」。macOS 在确认后先单独准备 Squirrel 原生安装器，不注册延迟退出回调；准备完成后再读取活动状态，防止这几秒内新启动的会话被稍后的回调中断。两次检查都通过才调用已就绪的 `quitAndInstall`。状态接口不可达、返回字段缺失、页面状态超时、会话锁无法判断时，一律拒绝重启，而不是按空闲处理。退出标志在实际安装前设置，避免 macOS 更新器关闭窗口时被应用的「关闭即隐藏」逻辑拦住。

这是一套**安装前检查**，不是运行任务的热迁移：历史保留不代表进程可以无缝续跑。安装器替换及系统重启路径需真实发布包验收；跨进程外部 TUI 在最终快照之后自行启动仍不受桌面端调度控制。

## 边界与数据流

1. `GET /api/update/check` 由运行时访问 GitHub API，比较当前构建 commit 与 `qirong77/mica-code/main`。远程窗口显示的是远程运行时的构建，不是本机 shell 的版本。
2. 本机打包版通过 `electron-updater` 检查 Release 中的 `latest-*.yml` 和安装包。受限 preload 只暴露 `status/check/download/install/onStatus`；每次调用核对登记窗口、主框架及 origin，并拒绝远程运行时窗口。
3. `GET /api/update/activity` 返回安装前所需的会话、提交和终端计数，走现有访问控制与 Host/Origin 检查。只在显式安装检查时读取 turn locks，不给底栏轮询或内存采样增加全盘扫描 / 子进程。
4. Electron 还检查受控终端、浏览器和编辑器，以及本机主页面当前的未保存状态。重启确认和错误反馈沿用原生确认框、共享通知 / 弹窗。

**当前更新包更新的是 Electron 外壳及其 Web 运行时。** 单独安装的 CLI（`~/.local/lib/mica` 或 `MICA_CLI_PATH` 指定的位置）仍须独立构建 / 安装，不能据桌面更新成功断言 CLI 也已更新。以解压 Electron + 外置 CLI 运行的 Linux 服务也不是 AppImage 安装器，不能通过远程页面直接替换；仍由该服务的部署流程更新。

## 发布与首次启用

正式桌面更新包必须由发布 workflow 产出完整的 manifest 和 payload：Linux 只把**已发布的 AppImage**视为支持；macOS 至少需要 `latest-mac.yml`、zip、`app-update.yml` 以及稳定的正式证书签名。adhoc 或临时本机签名可以运行，不能替代 macOS 发布签名，也不能据此宣称可更新。UI 的新提交提示不等于可安装的新版本。

发布 workflow 应使用官方 `macos-15`（Arm64）runner，并以更新专用测试 gate 阻止不完整发布；macOS 签名通过 `CSC_LINK` / `CSC_KEY_PASSWORD` 提供。macOS runner 不可用或证书未配置时必须明确告警并跳过 macOS 资产，不能上传未签名包，也不能阻断已经通过校验的 Linux 更新。manifest 必须引用实际存在的文件，并校验 SHA512 与 size；artifact 下载后还要再次验证，发布顺序先取并验证 metadata，再取 payload，失败时保留现有 Release，不删除已发布资产。2026-11-16 核查时 Release 仅有 Linux 资产，macOS runner 曾失败；这只是当时的线上状态，不是永久平台规则。

平台能力由主进程根据配置、运行架构、AppImage 运行环境和 macOS 签名门槛判定。当前桌面发布目标只有 **macOS arm64** 和 **Linux x64 AppImage**；Windows、macOS Intel、Linux arm64 没有桌面 CI 包，不能在 UI 或文档中虚称支持。缺少目标包时必须明确显示平台 / 架构原因和官方 Release 链接。完成正式签名发布后，首次启用需要安装该正式包，不能用源码目录包替代。

只有 CI 成功产出并发布了**当前平台可安装的包**，才有下载路径。macOS 还依赖系统认可的签名及安装条件；源码差异提示不能替代这些条件。

旧应用不会因为源码修改而自动获得修复后的主进程 / preload。首次接入或修复旧更新器，需要在没有任务运行时安装一次包含修复的新版本。不要在有人工作时覆盖正在运行的 `app.asar` 或强制重启。

## 主要实现与验证边界

| 文件                                                                 | 作用                                     |
| -------------------------------------------------------------------- | ---------------------------------------- |
| `apps/desktop/src/server/update-check.js`                            | GitHub commit 检查、缓存、单飞和失败保留 |
| `apps/desktop/src/server/index.js`                                   | 版本 / 安装活动只读接口                  |
| `apps/desktop/src/host/update-activity.js`                           | turn lease 检查、严格校验和阻塞原因      |
| `apps/desktop/src/host/chat.js`、`chat-idle.js`、`terminals.js`      | 从真实宿主状态和终端注册表导出活动情况   |
| `apps/desktop/src/main/app-update.js`                                | 原生状态机、窗口授权、安装确认和二次检查 |
| `apps/desktop/src/main/index.js`                                     | 汇总原生窗口与页面状态，安装退出标志     |
| `apps/desktop/src/preload/index.js`                                  | 受限更新桥                               |
| `apps/desktop/src/renderer/src/AppUpdateAction.jsx`、`app-update.js` | 点击动作、模式说明、进度和错误反馈       |

针对性测试覆盖 Set 窗口集合、权限、点击动作、下载状态保留、活跃 / 未知状态拒绝、取消与确认期间出现新工作。在 `apps/desktop` 中可运行：

```bash
# 平台与期望版本显式给定，避免把另一平台或残留旧清单当成功
node scripts/verify-update-assets.mjs dist mac 1.0.675
npm test -- scripts/verify-update-assets.test.js src/main/app-update.test.js src/renderer/src/app-update.test.js

# macOS：真实 Electron + preload IPC + MacUpdater + 本机 HTTP 更新源
node scripts/test-app-update-e2e.mjs
```

期望版本应替换为本次构建版本；Linux 使用 `linux`，Windows 使用 `win`。资产校验覆盖清单引用、SHA-512、大小、路径逃逸及更新器必需文件类型。

下载 E2E 使用独立的 `MICA_HOME` / userData / 端口和合成 ZIP，覆盖缺配置、正常下载、下载状态保留、忙 / 取消 / 远程窗口拦截、404、坏哈希拒绝与恢复、同版本 / 降级拒绝及 DMG-only 拒绝。测试不会调用原生 staging、`quitAndInstall`、签名或替换当前应用，临时数据结束后删除。**这些验证不等于真实 macOS / AppImage 替换、正式签名及重启链路验收。**

官方边界参考：[Electron autoUpdater 的 macOS 签名要求](https://www.electronjs.org/docs/latest/api/auto-updater)、[GitHub-hosted runner 标签](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。

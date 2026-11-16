# Mica 桌面端自动更新

## 用户行为

桌面页面每 10 分钟检查一次当前运行时对应的 `main` 最新提交；页面从后台切回前台时会立即检查。
如果远端提交号与当前构建不同，主对话底部左侧显示「有新版本」。没有更新时不占用底栏空间。

发布包版本已经下载完成时，按钮变成「重启更新」；只有用户点击它才会调用 Electron 的
`quitAndInstall`，不会在后台中断正在进行的会话、终端或浏览器操作。

## 两层检查

1. `GET /api/update/check` 在运行时侧访问 GitHub API，比较当前构建 commit 与
   `qirong77/mica-code` 的 `main`。因此远程连接窗口显示的是**远程 Mica 实例自己的版本**，
   不会误报本机版本。
2. Electron 打包版使用 `electron-updater` 检查 GitHub Release 的 `latest-*.yml` 和安装包。
   更新能力只通过受限 preload 暴露，主进程只接受登记为本机窗口的 sender；连接到另一台 Mica 的
   页面即使在 Electron 窗口里，也不能安装本机更新。

当前源码 / 开发模式只提供 commit 提示，不执行 `git pull` 或覆盖工作区。页面在没有本机安装器时
点击更新会打开对应的 GitHub 提交页。这样不会覆盖用户未提交的代码，也不会把远端页面变成任意
执行本机命令的入口。

## 发布链路

`.github/workflows/build-binaries.yml` 的 `desktop` job 在 `main` 推送时构建：

- Linux x64 AppImage；
- macOS arm64 zip / dmg；
- 与平台包对应的 `latest-linux.yml` / `latest-mac.yml` 和 blockmap。

桌面版本使用 `1.0.<GitHub Actions run number>`，避免 `apps/desktop/package.json` 里固定的开发版本
导致更新器认为每次构建都是同一版本。发布 job 把桌面包和 CLI 包一并放入可变的 `latest` Release。
`electron-builder.yml` 的 generic provider 指向该 Release 的 `latest/download` 地址。

首次发布这套工作流后，已构建的桌面版本才会有可下载的安装包；仅推送代码、但 CI 尚未成功发布
桌面包时，页面仍可显示 commit 更新提示，Electron 更新器不会伪称安装成功。

## 主要实现

| 文件                                                | 作用                                                |
| --------------------------------------------------- | --------------------------------------------------- |
| `apps/desktop/src/server/update-check.js`           | GitHub commit 检查、10 分钟缓存、单飞请求与失败保留 |
| `apps/desktop/src/server/index.js`                  | `/api/update/check`、health/env 构建 commit 信息    |
| `apps/desktop/src/main/app-update.js`               | Electron 更新状态机、事件广播、本机窗口授权         |
| `apps/desktop/src/preload/index.js`                 | 只暴露 check / download / install / onStatus        |
| `apps/desktop/src/renderer/src/AppUpdateAction.jsx` | 左下角更新入口与状态显示                            |
| `.github/workflows/build-binaries.yml`              | 桌面安装包构建及 Release 上传                       |

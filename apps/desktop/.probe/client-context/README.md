# Client context

在仓库根目录运行（需要已安装桌面端 Electron 及 `openssl`，不构建或重启运行中的应用）：

```sh
apps/desktop/node_modules/.bin/electron apps/desktop/.probe/client-context/probe.cjs
```

探针创建隔离的 MICA_HOME、桌面用户数据和 HTTP/HTTPS 页面，直接装载实际沙箱 preload、主进程客户端请求处理器与页面 API。临时证书仅为探针自己的 HTTPS origin 放行，结束后清理。

验证：

- HTTPS 页面只允许同源网络请求，且故意让所有 fetch 抛错，本机清单读取和版本比较写入仍通过原生桥成功。
- Local 恢复原本隐藏的窗口，保留草稿标记，返回时没有导航或重新加载。
- 本机未授权的插件数据、相同来源但未登记的另一个窗口不能使用客户端能力。

两小时隐藏回收仍由 `src/main/window-retention.test.js` 验证，不在此探针中改变保活期限。

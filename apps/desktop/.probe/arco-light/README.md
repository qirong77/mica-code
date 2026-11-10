# Mica 浅色 Arco 预览

使用真实共享组件和桌面样式的独立浏览器探针，不是安装包，也不会重启 Mica。

从仓库根目录运行：

```sh
npx vite --config apps/desktop/.probe/arco-light/vite.config.mjs
```

打开 <http://127.0.0.1:5236/>。固定回环地址、严格端口（占用时退出，不自动跳号）。

- **真实配置页**：原版 `ConfigPage` / `ProviderEditor`；展开服务商可修改字段、新增模型、测试连接，也可切换 JSON 表单。
- **控件与弹窗**：原版 `PageFrame` / `SettingsGroup` / `SettingRow` / `Input` / `Button` / `SelectMenu` / `Switch` / `Modal` / `DialogHost`，覆盖说明、占位、禁用、错误、compact、普通及危险确认、输入弹窗。
- 顶部切换浅色、Darcula、Latte 等真实主题，不读写主题缓存。链接可带 `?page=controls&theme=light` 直接打开控件页。
- CSS 只为预览外壳排版；不复制组件皮肤。共享源码的当前改动会直接反映到本页。

## 数据隔离

`setConfigWebClient()` 只注册内存实现。示例地址均为 `.invalid`，测试连接也只返回模拟结果，不发 API、不连接服务商、不使用 Electron IPC、不读取真实配置、不写盘、不使用 localStorage。配置页中“自动保存”“重新加载”仅对这份内存示例生效；刷新浏览器恢复初始数据。切换页面时配置页会按原组件行为 flush 内存修改。请勿输入真实密钥。

## 手动检查

1. 打开真实配置页，展开服务商：编辑字段、添加模型、测试模拟连接、检查错误与重新加载。
2. 切到控件页，编辑输入；把错误地址改为 `https://example.invalid/v1`，错误应消失。
3. 检查普通/compact 下拉、开关、禁用状态及按钮层级。
4. 打开三个弹窗与危险确认；验证 Tab / Shift+Tab 焦点、Esc、关闭后焦点回到触发项。输入弹窗清空后不能提交，非空时可按 Enter。
5. 缩窄到 390px，检查工具栏换行、内容区滚动、下拉与弹窗可用；切换 Darcula / Latte 做回归。

服务启动和浏览器交互验证由主代理执行；本探针不启动应用、构建安装包或连接线上环境。

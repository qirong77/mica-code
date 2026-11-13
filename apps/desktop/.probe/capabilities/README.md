# Capabilities 交互预览

仓库根目录运行：

```sh
bunx vite --config apps/desktop/.probe/capabilities/vite.config.mjs
```

打开 <http://127.0.0.1:15973/>。使用真实 `CapabilitiesPage` / `PromptControlsPanel` / 共享控件与主题，工具、插件和提示词为示例数据。开关、编辑、恢复与自动保存仅修改页面内存，刷新或点「重置示例」恢复。不会读写真实配置、会话或提示词控制文件。

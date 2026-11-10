# Notebook

Mica 里的本地笔记本：左侧目录树，右侧完整 Lexical 编辑器。入口为侧栏 **Notebook**，不依赖聊天会话或工作区目录。

## 第一版

- 新建笔记和多层文件夹、标题搜索、重命名、移动、最近删除与恢复。
- 正文约 650ms 自动保存，切换笔记或返回对话前确认保存；每篇笔记独立撤销历史、评论和图片说明。
- 保留 Lexical 0.53.0 编辑与表格能力：行列选择、增删、合并拆分、拖动换序、排序、批量样式及数据粘贴，以及图片、代码、公式、绘图、日期、Markdown/HTML 源码与 JSON 导入导出。
- 导出入口可下载当前正文 JSON；保存冲突时可以下载草稿，并明确确认后载入磁盘最新版，不静默覆盖另一窗口的正文。
- 主页面使用 Mica 共享 Arco 控件。隔离编辑器复用项目 `arco-settings.css` 的同一套主题映射，跟随宿主明暗主题与强调色。

## 本地数据

默认位置：

```text
$MICA_HOME/plugin-data/notebook/
  data.json               # version:1 的文件夹/标题索引，256 KiB 上限
  documents/<uuid>.json   # 每篇正文和评论，6 MiB UTF-8 JSON 上限
```

`MICA_HOME` 默认 `~/.mica`。正文不是浏览器 localStorage，也不依赖旧编辑器项目。图片上传和粘贴按编辑器规则以内嵌内容保存，计入正文上限；网络图片仍是远程引用。重要笔记建议额外导出备份。

写盘复用宿主跨进程锁、内容版本比较、0600 权限、临时文件原子替换。不同笔记互不覆盖；同篇版本冲突保留内存草稿并提示处理。最近删除是索引软删除，不删除正文文件。读取非法/损坏笔记明确报错，不把它当空文档覆盖。

## 运行时依赖

全部核心源码在本目录 `editor/src/`，之后在此维护。`editor/cdn.mjs` 固定第三方版本，浏览器通过 esm.sh 加载 ESM、jsDelivr 加载样式与字体；本地插件产物只包含一方代码、图标和编辑器主题资源，不复制第三方 JS 库。Lexical 导出与 `.js` 别名由 import map 统一，避免编辑器上下文出现两个实例。

编辑器在无 `allow-same-origin` 的 sandbox iframe 中运行，通过 iframe WindowProxy + 随机 nonce 校验的消息桥交换当前笔记正文，不提供 Mica API 或文件系统权限。CDN 只负责库文件，不发送笔记正文；网络图片/视频等外部嵌入会请求相应站点。首次打开需要网络；不能承诺完全离线运行，CDN 失败时展示可重试错误且不清空本地笔记。

协同服务、分享快照和会重建文档的 Playground 实验模式不用于本地笔记。源码模式下需先返回富文本再保存或切换，避免源码字符串覆盖原文档；语音及外部嵌入仍受浏览器能力、iframe 权限和网络约束。

## 开发

独立编辑器的开发依赖不加入 Mica 主运行时依赖：

```sh
cd plugins/notebook/editor
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
```

主仓库类型检查排除独立 CDN 编辑器，分别检查。桌面 renderer 的通用 `pluginWebAssets()` 自动发现 `plugins/*/web-build.mjs`，将页面构建到 `out/renderer/plugin-web/<id>/`，正常桌面构建会包含它；无需修改宿主业务分支。开发服务首次请求时按需构建到仓库 `temp/plugin-web-dev/`。

仅测试独立页面资源时（输出放临时目录，不覆盖已安装应用）：

```sh
node --input-type=module -e "import build from './plugins/notebook/web-build.mjs'; await build({ outDir: '/private/tmp/mica-notebook-assets' })"
```

当前协议与索引均为首版，无存量格式迁移。编辑器上游代码保留 Meta MIT 版权头，许可证见 `LICENSE.lexical`。

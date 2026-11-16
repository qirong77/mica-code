# Global Search

通过系统全局快捷键 `Alt+Space` 打开搜索浮窗，查找配置目录下的文件和文件夹。搜索范围由插件设置决定，不依赖当前会话、工作区或进程工作目录。列表里每条结果占两行：上一行用 VS Code 打开，下一行在 Mica 的**新编辑器窗口**里打开（当前窗口不动）。

第一版按文件名和路径搜索，不搜索文件正文或其他应用数据，暂未迁移 VsGo 的拼音输入匹配。支持中文名称、空格路径、大小写无关的子串与子序列匹配。名称匹配优先于路径匹配，同级结果使用支持中文拼音排序的 `Intl.Collator` 排序。

## 使用

1. 打开 **Settings → Plugins → Global Search**，在「搜索目录」里点「选择文件夹」挑目录（也可以直接改路径），自动保存。
2. 桌面应用运行时，在任意应用按 **Option + 空格** 唤出；也可以点插件详情的「打开 Global Search」。
3. 输入关键词，↑/↓ 选择，Enter 打开当前行：每条结果的第一行用 VS Code 打开，第二行在 Mica 的新编辑器窗口里打开（光标不动旁边那个窗口）。Esc 或点击其他窗口收起。

关闭 Mica 主窗口后仍可唤起；退出应用或停用插件后快捷键释放。VsGo 等应用同时占用 Option + 空格时，先退出占用的应用，再从插件设置重新打开搜索；窗口会显示快捷键注册状态。

## 打开方式

每条结果展开成两行，行首图标组就是两条记录的区别（沿用 VsGo 文件启动列表的做法：同一路径两条记录、靠应用图标区分）：

```
[VS Code] → [文件]  名字        父目录
           [文件]  名字        父目录
```

- 第一行执行 `open -a "<应用名>" <路径>`：目录作为 VS Code 工作区打开，文件直接打开。应用名取自设置 `editorApp`，默认 `Visual Studio Code`。
- 第二行走桌面启动器的 `openPath`：外壳开一扇**编辑器窗口**（`?editor=<路径>`，底栏左下 Git、右下文件路径），主窗口保持不动。同一条路径只留一扇窗，重复打开只是把它端到前面。
- 打开成功后才记入最近打开并收起浮窗；失败留在浮窗里显示原因（`open` 的 stderr），不收起、不记最近记录。
- 没装这个应用（`.app` 不在 `/Applications`、`/System/Applications`、`~/Applications`）时列表退回单行、只留 Mica 行，并在顶部提示可以改应用名。
- 非 macOS 走 `code` 命令；用 VS Code 打开要能起进程，所以只有桌面应用里可用。

界面沿用桌面端 `⌘P` 快速选择器的密度：42px 搜索行、28px 结果行，左侧文件名、右侧淡色父目录（`~/` 开头，超出四段截断为 `…/`），选中行是应用的 `--color-active` 底，底部一行 11px 提示与结果数、搜索范围。颜色只取 `app.css` 的 `--color-*` 令牌，因此跟随主题切换。

## 设置与范围

- `searchDirectories`：一行一个绝对目录，支持 `~` 和 `~/`，默认值为 `~/Desktop`、`~/Downloads`。设置页用系统文件夹选择器添加（`type: directories`），存的仍是这份换行文本。空配置表示不搜索任何目录；相对路径会给出警告，不会相对于会话解析。
- `editorApp`：VS Code 的应用名，默认 `Visual Studio Code`，写成 `Cursor.app` 也认（后缀会被去掉）。用 Cursor 填 `Cursor`，Insiders 填 `Visual Studio Code - Insiders`。这里要的是应用本身的名字而不是命令行工具名——打开走 `open -a`，不要求 `code` 命令装进 PATH。
- `maxDepth`：默认 1，范围 1–16。根目录深度为 0；值为 1 时包含根目录及直接子项，不读取子目录的内容。遇到深度边界上的目录会保守地标记 `truncated`，即便该目录实际为空。
- 返回配置根目录本身及递归文件、文件夹。重叠根目录去重，每个显式根目录独立获得完整深度额度。
- 忽略符号链接、隐藏目录，以及 `node_modules`、`dist`、`out`、`build`、`coverage`、`Library`、`__pycache__`、`venv`、`Pods`、`bower_components` 等常见产物目录。显式配置的根目录本身不按目录名过滤。隐藏文件仍可搜索。
- 缺失目录、权限不足和无效根目录会出现在返回的 `warnings`，其他可访问目录仍然可用。浮窗只展示结果、条目数与范围，不渲染 `warnings` 和 `truncated` 提示。被系统拒绝的目录冷却 10 分钟再重试，避免反复触发权限提示。

单次扫描最多收集 **50,000 个条目**（含根目录），遍历 **10,000 个目录**，并受 **8 秒扫描时限**约束。时限检查覆盖遍历循环与异步文件系统操作；超限返回已收集结果，并设置 `truncated: true`。深度限制同样会设置该标志。权限或缺失路径由警告说明。

索引缓存 30 秒；相同配置的并发扫描共用进行中的任务。更改根目录或深度后重建索引，传入 `refresh: true` 可以主动刷新。每次查询最多返回 80 条结果；空查询显示仍然存在且位于当前根目录中的最近打开记录、根目录和顶层文件夹。非空查询也可匹配有效的最近记录，包含尚未进入当前深度索引的路径。

最近打开记录保存于插件的全局数据，与会话无关，去重并保留 30 条。显示前检查路径是否存在、是否在当前根目录内、是否经过子级符号链接。配置范围改变后，旧范围中的记录不会显示，也不能再次记入。

最近路径校验另有 1.5 秒时限：无响应的磁盘不会阻塞整份搜索，超时项跳过并计入 `warnings`。记录最近打开时超时会明确失败，不阻塞后续记录；停用插件会取消等待中的校验。

## 桌面运行时接口

`index.ts` 仅提供空 `setup`。快捷键注册、独立浮窗、页面加载与生命周期由桌面运行时承担；插件清单不声明会话 `entry` 或 `page`，也不请求工具依赖。快捷键已被其他应用占用时，由运行时向页面显示注册状态。

`launcher.js` 默认导出 `createLauncher(ctx)`，返回：

```ts
{
  request(action: 'search' | 'remember', input: unknown): Promise<unknown>;
  dispose(): void;
}
```

上下文需要提供：

```ts
ctx.settings.get(); // 同步返回当前插件设置
ctx.readData(); // 返回 { value, version }，缺文件时两者都是 null
ctx.writeData(value, { expectedVersion }); // 返回 { ok: true } 或 { ok: false, conflict: true }
```

初始记录使用 `expectedVersion: null`。全局数据结构为 `{ recent: string[] }`；写入时保留其他已有字段。宿主的版本比较与原子写入在同一跨进程锁内执行，版本冲突返回 `{ ok: false, conflict: true }`。`remember` 重新读取最新数据和设置，重放同一条最近记录更新，最多尝试 8 次；同一实例内写入串行执行。

### 查询

```ts
await launcher.request('search', { query: '中文 文件', refresh: false });
// {
//   items: [{ path: '/absolute/path', name: '文件名', type: 'file' | 'directory' }],
//   roots: ['/configured/root'],
//   warnings: [],
//   truncated: false,
//   indexed: 1234, // 扫描收集的唯一条目数，含根目录；并非查询命中数
//   editor: { app: 'Visual Studio Code', available: true }
// }
```

`roots` 是规范化后的配置路径，可能包括当前不可访问的根目录；具体异常见 `warnings`。`query` 必须是字符串。`editor.available` 回答「这个应用装没装」——macOS 上看 `.app` 是否在常规安装目录里，非 macOS 恒为 true（`code` 是否可用要到打开时才暴露）；页面据此决定列表要不要多画 VS Code 行。`dispose()` 后拒绝新请求，清除缓存，进行中的扫描会在下一个检查点停止。

### 用 VS Code 打开

```ts
await launcher.request('openEditor', { path: item.path });
// { ok: true, app: 'Visual Studio Code' }
```

先按最近记录那一套规则校验路径（存在、在当前根目录内、不经过子级符号链接），再 `spawn('open', ['-a', app, path])`（非 macOS 用 `code <path>`），等子进程退出码：`open` 把「找不到应用」写在 stderr 上，非 0 退出时把 stderr 作为错误抛出。打开超时 15 秒。这个动作不写最近记录，也不收起浮窗——编排由页面做。

### 记录成功打开的路径

```ts
await host.openPath(item.path); // Mica 行：外壳新开编辑器窗口，成功后才进行下一步
await launcher.request('openEditor', { path: item.path }); // VS Code 行
await launcher.request('remember', { path: item.path });
// { ok: true }
```

`remember` 只记录当前配置范围内存在的普通文件或目录；拒绝缺失路径、范围外路径和子级符号链接。Mica 那条路由页面调 `openPath`（外壳开新窗口），后端只负责 VS Code 那条路。页面应分别处理打开与最近记录保存失败：保存失败不应让已经打开的文件被视为打开失败。

## 测试

从 `mica-code` 仓库根目录运行：

```sh
bunx vitest run --project unit plugins/global-search/search.test.ts
bunx vitest run --project unit plugins/global-search/launcher.test.ts
bunx vitest run --project unit plugins/global-search/desktop.test.ts
```

测试使用临时文件系统，覆盖中文与空格路径、文件夹和递归深度、隐藏及产物目录、符号链接、重叠根目录、权限异常 mock、扫描条目/目录/时间预算、查询排序及 80 条上限、缓存与并发去重、配置变更，以及全局最近记录的版本冲突重放、并发写入、30 条限制和范围校验。`launcher.test.ts` 用注入的 `spawn` 桩覆盖 `openEditor`：命令与参数（应用名取自设置、去掉 `.app` 后缀）、stderr 报错、范围外路径拒绝且不起进程、非 macOS 回落 `code`，以及 `search` 返回的 `editor.available`。无需构建或重启应用。

`desktop.test.ts` 渲染真实共享 Arco 输入框并检查插件局部 CSS 合约：填满搜索行、继承字体、透明无边框、主题 placeholder，以及 hover / focus / disabled 不改变外观或尺寸；另外用 `buildRows` 固定行配对规则（每条结果 VS Code 行在前、没有应用时退回单行）。浏览器层叠与实际尺寸用 `apps/desktop/.probe/global-search/` 测量（运行方式见 `.probe/README.md`），包括 767px 以下触发的窄屏字号规则；探针不连接真实搜索或打开文件。

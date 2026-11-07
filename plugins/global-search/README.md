# Global Search

通过系统全局快捷键 `Alt+Space` 打开搜索浮窗，查找配置目录下的文件和文件夹。搜索范围由插件设置决定，不依赖当前会话、工作区或进程工作目录。选中结果后，由桌面页面调用 Mica 的 `openPath` 打开。

第一版按文件名和路径搜索，不搜索文件正文或其他应用数据，暂未迁移 VsGo 的拼音输入匹配。支持中文名称、空格路径、大小写无关的子串与子序列匹配。名称匹配优先于路径匹配，同级结果使用支持中文拼音排序的 `Intl.Collator` 排序。

## 使用

1. 打开 **Settings → Plugins → Global Search**，在「搜索目录」里点「选择文件夹」挑目录（也可以直接改路径），自动保存。
2. 桌面应用运行时，在任意应用按 **Option + 空格** 唤出；也可以点插件详情的「打开 Global Search」。
3. 输入关键词，↑/↓ 选择，Enter 在 Mica 编辑器打开文件或目录；Esc 或点击其他窗口收起。

关闭 Mica 主窗口后仍可唤起；退出应用或停用插件后快捷键释放。VsGo 等应用同时占用 Option + 空格时，先退出占用的应用，再从插件设置重新打开搜索；窗口会显示快捷键注册状态。

界面沿用桌面端 `⌘P` 快速选择器的密度：42px 搜索行、28px 结果行，左侧文件名、右侧淡色父目录（`~/` 开头，超出四段截断为 `…/`），选中行是应用的 `--color-active` 底，底部一行 11px 提示与结果数、搜索范围。颜色只取 `app.css` 的 `--color-*` 令牌，因此跟随主题切换。

## 设置与范围

- `searchDirectories`：一行一个绝对目录，支持 `~` 和 `~/`，默认值为 `~/Desktop`、`~/Downloads`。设置页用系统文件夹选择器添加（`type: directories`），存的仍是这份换行文本。空配置表示不搜索任何目录；相对路径会给出警告，不会相对于会话解析。
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
//   indexed: 1234 // 扫描收集的唯一条目数，含根目录；并非查询命中数
// }
```

`roots` 是规范化后的配置路径，可能包括当前不可访问的根目录；具体异常见 `warnings`。`query` 必须是字符串。`dispose()` 后拒绝新请求，清除缓存，进行中的扫描会在下一个检查点停止。

### 记录成功打开的路径

```ts
await host.openPath(item.path); // 页面判断打开成功后才进行下一步
await launcher.request('remember', { path: item.path });
// { ok: true }
```

`remember` 只记录当前配置范围内存在的普通文件或目录；拒绝缺失路径、范围外路径和子级符号链接。后端不执行打开操作，也不提供 `open` action。页面应单独处理 `openPath` 和最近记录保存失败：保存失败不应让已经打开的文件被视为打开失败。

## 测试

从 `mica-code` 仓库根目录运行：

```sh
bunx vitest run --project unit plugins/global-search/search.test.ts
```

测试使用临时文件系统，覆盖中文与空格路径、文件夹和递归深度、隐藏及产物目录、符号链接、重叠根目录、权限异常 mock、扫描条目/目录/时间预算、查询排序及 80 条上限、缓存与并发去重、配置变更，以及全局最近记录的版本冲突重放、并发写入、30 条限制和范围校验。无需构建或重启应用。

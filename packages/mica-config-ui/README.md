# mica-config-ui

配置页（Mica Config）的**唯一一份实现**：页面组件、数据动作与共享类型。两个宿主都用它，区别只在「谁提供数据、谁来渲染」。

- **浏览器宿主**（`apps/config-web`）：Bun HTTP 服务托管页面产物（`bun run build:config-web` 生成内嵌资源），页面走同源 `/api/*`。
- **桌面宿主**（`apps/desktop`）：运行时把数据动作暴露成 IPC（`config-web:invoke`），renderer 直接渲染页面组件——不起 config-web 子进程，也没有 iframe。设置页因此永远读写**页面所连那台运行时**的 `$MICA_HOME`：切到另一台服务器后，改的就是那台的配置。

## 目录

```
index.ts                 Node 侧入口：数据动作、路径工具、共享类型（浏览器宿主用）
src/shared/types.ts      页面与数据层共用的类型
src/server/
  actions.ts             「动作名 → 数据操作」表（HTTP 与 IPC 两个传输层的唯一语义来源）
  details.ts             动作实现（MCP / skills / roles / plugins / sessions）
  configFiles.ts         config.json 读写与校验
  paths.ts               $MICA_HOME 下的各路径
  conversation.ts        history → 可读对话项
  sessionAnalysis.ts     history → 上下文占用分解
  sessionView.ts         上面两者的「纯逻辑」出口（桌面运行时可复用，见下）
web/                     页面组件（React）
  index.tsx              宿主入口：ConfigWebApp / setConfigWebClient / setConfigWebEditor
  api.ts                 数据源接口 ConfigWebClient + 模块级注册与转发
  editor.ts              编辑器接口与注册（默认给一个朴素文本域兜底）
  App.tsx styles.css 等  页面本体
```

## 在宿主里怎么接

```ts
setConfigWebClient(myClient)   // 见 web/api.ts 的 ConfigWebClient
setConfigWebEditor(MyEditor)   // value/language/readOnly/onChange，见 web/editor.ts
render(<ConfigWebApp />)
```

- 浏览器宿主用 `apps/config-web/web/src/http-client.ts`（`fetch('/api/*')`）+ CDN 版 monaco（`monaco-editor.tsx`）。
- 桌面宿主用 `apps/desktop/src/renderer/src/config-web.js`（`config-web:invoke`）+ 应用自带的本地 monaco（`config-web-editor.jsx`）。

## 只在桌面宿主出现的章节

`web/App.tsx` 的 section 白名单与 `web/layout/Sidebar.tsx` 的条目按宿主能力区分，浏览器宿主（`apps/config-web`）没有桌面运行时那两份数据：

- **Auto Compact**（`supportsAutoCompact()`）：设置与按会话记账的计数活在运行时的 `userData/auto-compact.json`。**能力不存在时连侧栏入口都不显示**，带 `?section=autoCompact` 的深链退回 Config。
- **Browser Control**（入口**各处都在**，不受能力门控）：受控浏览器窗口活在 Electron 主进程，运行时是纯 Node，两边靠本机 socket / 运行时端口上的 `/remote/control` 通信（`apps/desktop/src/host/browser-control.js`）。页面只讲三件事：服务状态（含**技能文档全文**）、技能文档与接口文档；纯逻辑（技能文档取值、接口分组、curl 示例）在 `web/browserControl.ts`。
  - 入口刻意不藏：它是「Mica 里有一套能真正打开的浏览器」这件事的唯一说明处，藏起来会让人以为 Mica 没有这个能力。拿不到服务时 `readBrowserControlDetails()` 交回一份显式不可用的详情（`unavailableBrowserControlDetails`，reason 说清「只有从 Mica Code 应用里打开的配置页才连得上」并给出怎么开），页面照常渲染并提示未开启，`?section=browserControl` 也因此永远有效。
  - **这一页不管窗口**：开、显示、隐藏、关闭分别由 agent 调接口与主区顶栏的地球图标完成，页面列出来只会让人以为得手动建。客户端只有 `readBrowserControlDetails` 一个方法，**不要**再加回 create/close/show/hide（`ConfigWebClient` 上没有它们）。
  - **技能文档显示的是应用生成的那一份**（`details.skillMarkdown`），不是去读用户目录里的副本：那份副本由应用在启动时写出，改它会被下次启动覆盖。要改文档就改源头 `apps/desktop/src/main/browser/browser-docs.js`（页面上有这条说明，见 `SKILL_SOURCE_NOTE`）。

## 约定

- **样式必须限定在 `.mica-config-ui` 容器内**：`web/styles.css` 把全部规则放进 `@scope (.mica-config-ui) { … }`，自定义属性也定义在容器上而不是 `:root`。桌面端把它当普通视图内嵌渲染，规则不能泄漏到应用其余部分，也不能被应用的同名变量覆盖（应用用 `--color-*`，这里用 `--bg/--panel/--text`）。新增样式沿用这个作用域，不要写裸标签选择器到作用域之外。
  - **页面级的根高度链归宿主**：`html/body/#root { height: 100% }` 这类规则**不要**写在这份共享样式里。宿主的样式表（`apps/desktop/.../app.css`）装在 `@layer base`，而这份是后加载的无层级样式，同优先级下必然把它顶掉——桌面端移动端的根容器高度（`--vvh`，软键盘避让全靠它）会因此静默失效，表现是手机上输入条留在键盘下面。整页托管这份页面的浏览器宿主自己写：`apps/config-web/web/src/host.css`。
- **页面不自己读数据**：所有数据操作都经 `ConfigWebClient`，宿主实现传输层；宿主没注册时页面会明确报错，不静默降级。
- **桌面宿主的数据实现与 CLI 宿主各自独立**：`apps/desktop/src/host/configWebData.js` 直接读写本机 `$MICA_HOME`（纯文件，不依赖 CLI 的运行时包），CLI 宿主用本包的 `details.ts`（依赖 `mica-mcp`/`mica-session`/`mica-skills`/`mica-config`/`mica-agent`）。两边的返回结构由 `src/shared/types.ts` 约束，改动数据结构要同步两处。
- **`sessionView.ts` 是纯逻辑出口**：桌面运行时只引它（`history → 对话项 / 上下文分解`，不碰文件系统、不引 `mica-agent` 的值）。因此 `conversation.ts` 里的类型导入必须写成 `import type … from '@packages/mica-agent/core/Conversation.js'` 这种**关键字形式 + 具体文件**：写成 `import { type X } from '@packages/mica-agent/index.js'` 时，Vite 在桌面端构建里不会剥掉它，会把整个 agent 包（含 `prompt/system.md`）拉进运行时 bundle 并直接构建失败。
- 改配置页交互（新建/删除/放弃修改）后必须跑 `bun run build:config-web` 重新生成 `apps/config-web/src/server/generatedStaticAssets.ts`，内嵌产物随源码一起提交。

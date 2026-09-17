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

## 约定

- **样式必须限定在 `.mica-config-ui` 容器内**：`web/styles.css` 把全部规则放进 `@scope (.mica-config-ui) { … }`，自定义属性也定义在容器上而不是 `:root`。桌面端把它当普通视图内嵌渲染，规则不能泄漏到应用其余部分，也不能被应用的同名变量覆盖（应用用 `--color-*`，这里用 `--bg/--panel/--text`）。新增样式沿用这个作用域，不要写裸标签选择器到作用域之外。
- **页面不自己读数据**：所有数据操作都经 `ConfigWebClient`，宿主实现传输层；宿主没注册时页面会明确报错，不静默降级。
- **桌面宿主的数据实现与 CLI 宿主各自独立**：`apps/desktop/src/host/configWebData.js` 直接读写本机 `$MICA_HOME`（纯文件，不依赖 CLI 的运行时包），CLI 宿主用本包的 `details.ts`（依赖 `mica-mcp`/`mica-session`/`mica-skills`/`mica-config`/`mica-agent`）。两边的返回结构由 `src/shared/types.ts` 约束，改动数据结构要同步两处。
- **`sessionView.ts` 是纯逻辑出口**：桌面运行时只引它（`history → 对话项 / 上下文分解`，不碰文件系统、不引 `mica-agent` 的值）。因此 `conversation.ts` 里的类型导入必须写成 `import type … from '@packages/mica-agent/core/Conversation.js'` 这种**关键字形式 + 具体文件**：写成 `import { type X } from '@packages/mica-agent/index.js'` 时，Vite 在桌面端构建里不会剥掉它，会把整个 agent 包（含 `prompt/system.md`）拉进运行时 bundle 并直接构建失败。
- 改配置页交互（新建/删除/放弃修改）后必须跑 `bun run build:config-web` 重新生成 `apps/config-web/src/server/generatedStaticAssets.ts`，内嵌产物随源码一起提交。

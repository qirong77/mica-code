# UI 规范

## Ink

- `mica-ui` 只管组件/store，runtime 经 `MicaUiRuntimeBridge` 映射。
- Ink stdin 到 `parse-keypress.ts` 前保留 Buffer；Alt 两种编码都要支持。
- 编辑撤销/重做历史保存在组件 ref；`displayContent` 只改展示。
- 工具行占一行（`wrap="truncate-end"`），思考整段折行。

## 配置页

- `mica-config-ui` 是唯一实现：config-web 用 HTTP 托管，desktop SettingsView 直接嵌组件，不起 iframe 或子进程。
- 两个宿主都整页打开：桌面端点左下角设置按钮、左上角插件菜单，都以覆盖整窗的一层渲染 `<App>`（`section` 定位到 Config 或 Plugins、`pluginId` 定位到插件详情，`onClose` 渲染左上角返回）。页面内导航由侧栏切换，不做弹窗内嵌。
- 新页面只用既有积木：`PageFrame`、`Button`、`Tag`、`Switch`、`CollapsiblePanel`、`SettingsGroup`、`SettingRow`、`SplitView`、`ControlEndpointList`；文案走 `labels.ts`。
- 三块骨架：`PageFrame`（窄页头 + 内容区）、`SettingsGroup` + `SettingRow`（一页一块面，行间分隔线）、`SplitView`（左列表 + 右详情）。
- Web 基础控件以 Arco Design React 为实现：`Ui.tsx` 保留共享语义接口，`SelectMenu` / `DateField` / `Modal` / `DataTable` 适配原有业务契约，普通输入从共享入口引入 `Input` / `InputNumber`。`ArcoProvider` 供完整 App 统一配置语言、尺寸与弹层容器；`ArcoAction` 透传原生按钮事件与 ref。`arco-settings.css` 按需载入控件样式，在 `body.mica-arco-theme` 与 `.mica-config-ui` 映射主题；页面旧控件皮肤不得覆盖 Arco。保留页面骨架、导航、布局与专用编辑器，不另写第二套基础控件。
- 纯图标动作显式传 `iconOnly`，共享适配层用双轴居中，禁止沿用文字内边距；文字动作继承所在工具栏字号与字色，状态色仍交给 Arco。普通导航、工具栏与文字动作使用当前主题的中性色，不套 Arco 默认蓝色；主操作与选中态才使用主题强调色，危险/成功/警告保留语义色。主题沿用现有六套与 `auto`，组件及 body Portal 通过同一份 token 映射即时更新。
- 折叠按容器宽度（`@container page (max-width: 860px)`），不按视口。
- Config 页只按字段编辑 providers；`mcpServers` 与 `capabilityDefaults` 不在这页编辑——前者在 MCP 页按字段填，后者跳到 Capabilities 页。
- MCP 页没有左列表：`mcpServers` 的协议与字段是固定的，一页就一个 `SettingsGroup`，一个 server 一张可折叠的 `entry-row`（与服务商同一套行），折叠行显示名称 / 连接方式 / 命令或地址 / 连接状态，展开接字段行。类型用 `Segmented`，本地进程填命令 / 参数 / 环境变量 / 工作目录 / 标准错误，HTTP 填地址 / 请求头；切类型会删掉另一侧的已知键（文件里同时留着 `command` 与 `url` 的条目说不清是哪种）。连接状态与工具列表只属于磁盘上那份配置，类型换掉后不再显示。右上角「编辑 JSON」是**整份** `mcpServers`（也接受文档里抄来的 `{ "mcpServers": { … } }`），与表单是同一份内容的两种形态；转换唯一实现是 `web/mcpDraft.ts`。
- MCP 的读写都走整份：`readMcpDetails` 返回文件里的 `mcpServers` 原文（`content`，不展开 `${VAR}`——按展开后的值写回去会把占位符换成这一台机器的端口），保存是 `writeMcpServers(content)` 一次写整份。逐条写会把改名 / 删除拆成两次请求。
- 服务商在分组里是一行：折叠显示 id（唯一的名称，不再另设显示名称）/协议/地址/模型数，展开接字段行；有错误强制展开并标「待修正」。模型列表全靠手填（没有「模型列表地址」），展开体最后一行是「测试连接」：它用页面上当前的地址 / Key / 协议 / 第一个模型发一次最小请求，结论就写在按钮右边。
- Sessions 左栏的会话信息由 `src/server/sessionHead.ts` 只读文件头 8KB 解析，两个宿主共用。
- 浏览器侧（`web/`）只能 import 纯子模块：`mica-plugin` / `mica-common` 的包入口会顺带导出读写文件的模块，dev 下整页白屏且 tsc 与单测都看不出来（`web/browserImports.test.ts` 静态挡住）。
- 密钥类输入统一用 `web/components/SecretInput.tsx`：默认密文 + 眼睛按钮切明文，明文状态在组件内，收起或换页自动回到密文。
- 配置页不提供 effort 开关：由模型规则按模型名决定。
- 表单转换唯一实现 `web/configDraft.ts`；写入保留未知键，已知键固定顺序，可选字段留空即删键。MCP 页同理（`web/mcpDraft.ts`）。
- Capabilities 页改 `config.capabilityDefaults`，读写实现在 `src/server/capabilityDefaults.ts`。
- 插件页是「目录 + 整页详情」：目录首个页签是「全部」，其后按已声明的桌面能力 / 可配置能力 / 其他工具 / 用户来源切换卡片网格（停用的卡片压暗），每张卡显示清单 `icon`（`web/pluginIcons.tsx` 的映射表，未登记回落 `puzzle`）与一枚启停开关（卡片是「外壳 + 打开详情的按钮 + 右上角的开关」，开关不能塞进按钮里）；点开进入单插件详情页，返回走详情页自己的返回行。**开关是唯一的启停控件**：卡片脚注与详情页信息表的「加载」行只说装配结论（已加载 / 已跳过 / 加载失败 / 尚未加载，停用时是「已停用」），不要再放一枚「已启用」标签去重复开关的语义（唯一实现在 `pluginRunningStatus()`）。清单 icon 不参与内核逻辑，只在配置页呈现。
- 详情页右侧信息表只有标识 / 加载 / 目录 / 日志四行、单行省略；「日志」是路径链接（单击选「在 Finder 中打开 / 在 Mica 中打开」，⌘ 点击直接进编辑器，用的是 `PathLink` + 宿主的 `revealPath` / `openPathInEditor`），目录那行不是——官方插件的目录是仓库里的相对路径。插件里的文件清单不进界面（`PluginInspection` 不读目录），用户要的是「装没装上」而不是文件浏览器。
- 插件设置在详情页按清单渲染：开关用共享 `Switch`，数字用 Arco `InputNumber` 的按钮模式，单位定宽；手输草稿不夹值，步进才按边界归一，校验与落盘规则不变。
- 所有页面不设保存按钮：`useAutoSave`（400ms 防抖、串行写盘、卸载补发）；校验不过不写盘。
- 新建/删除/放弃用 `DialogHost` 的 confirmDialog / promptDialog。
- 配置页产物由用户决定何时生成：明确要求构建时跑 `bun run build:config-web` 并更新 `generatedStaticAssets.ts`；日常源码改动不自动构建或重启。
- 样式限定 `.mica-config-ui`；桌面 app.css 与配置页共用 Darcula 暗色 token；页面级 html/body 高度链归宿主。

## 主题（6 套主题 + 跟随系统）

- 主题是默认能力：「跟随系统 / Darcula / 浅色 / Catppuccin Mocha / Catppuccin Latte / Tokyo Night / Tokyo Night Light」，设置在 Settings → Appearance（偏好存运行时界面状态 `theme`，默认 `auto`）。注册表只有一份：`packages/mica-web-shared/theme.ts` 的 `THEMES`（id / 明暗档 / 画布色 / 同源配对的另一档）；`apps/desktop/src/renderer/src/theme.js` 是渲染层唯一入口，切换只改 `<html data-theme>` 与 `data-appearance`，不重载页面。
- `<html data-theme='<id>'>` 选具体主题，`<html data-appearance='light|dark'>` 只表达亮/暗——所有「亮底要单独处理」的规则（阴影权重、查找条输入框、屏幕涂层）都挂在 `data-appearance` 上，新增主题自动继承，别按主题 id 再写一遍。
- 颜色只用 `--color-*` / `.mica-config-ui` 容器变量：默认暗色（Darcula）的取值在 `@theme` 与 `.mica-config-ui` 默认块里，其余每个主题一个 `html[data-theme='<id>']` 块。**加主题 = 注册表加一项 + 各宿主补一个块**：桌面 `assets/app.css`、设置页 `packages/mica-config-ui/web/styles.css`（含主题卡预览色板）、终端窗口 `renderer/src/terminal-page.css`、xterm 表 `renderer/src/terminal-theme.js`、monaco 主题（`monaco-runtime.js` 用 `--color-*` 的镜像值）。`theme-tokens.test.js` / `appearance-tokens.test.ts` / `theme-boot.test.js` 会逐个主题拦住漏掉的那处。
- 第三方主题的取值走**上游原始调色板**，不照着截图调：Catppuccin 取自官方 `palette.json`（`mocha` / `latte` 的 `colors` + `ansiColors`），Tokyo Night 取自 `enkia/tokyo-night-vscode-theme` 的 theme JSON。亮底主题的 ANSI 彩色若在上游画布上不够 4.5:1（Catppuccin Latte 的绿/黄/品红就是），按同一色相压暗后再落地，并在块里写一行注释说明——别直接抄上游导致终端输出糊在浅底上。
- 亮色的取值**逐档取自 DeepSeek harness 开源仓库**（`deepseek-ai/deepseek-harness` 的 `packages/client/ui-theme/src/styles/design-platform.css`：`--dsw-static-neutral-bluish-*` 调色板 + `--dsw-alias-*` 语义层；对话各层的用法看 `packages/client/ui-chat/src/client/chat/*.module.css`），不是照着截图调出来的，要核对就 `dsh web` 起一份真界面读计算样式。改亮色前先看那份文件的语义：正文、菜单、标题都是 `label-primary`（neutral-bluish-1000 近黑，不是中灰；亮色顶端两档因此并成同一个值），过程文字（工具行/思考/时间戳）是 `label-tertiary`（neutral-bluish-600），用户消息带是 `--dsw-specific-bubble`（deepseek-50 淡蓝），行内代码是 `markdown-inline-code`（浅底 + `border-l1` 描边），面板是 `neutral-bluish-50`，选中行是 `neutral-bluish-100`（= `--color-active`，会话行/导航/文件树都用它，不要用洗色层凑），洗色层是带蓝调的 `rgba(38 49 72, α)`。
- 因此亮色有五个专属 token 不能回退成通用灰阶：`--color-nav-fg`（侧栏/菜单行）、`--color-bubble`（用户消息带）、`--color-inline-code{,-bg,-border}`（行内代码药丸）、`--color-heat-empty`（热力图空格：亮色 canvas 是纯白，铺在 panel 卡片上等于没有网格）。`theme-tokens.test.js` 钉住了这些锚点，值要改就一起改测试并写明理由。
- 提问（`ask` 插件）有一支**自己的识别色** `--color-ask` + 压在它实心底上的字色 `--color-ask-contrast`：卡片问号徽标、选中选项、「确定」按钮、输入框聚焦边框，以及侧栏/快速打开里「等你做一个选择」的圆点全用它。**不要退回主题强调色**——强调色在浅色主题里就是蓝色，会和未读蓝点、主按钮混在一起，一笔等你点选的卡片就认不出来。六个主题各取自家调色板的青（Darcula ansiCyan / Catppuccin teal / Tokyo Night ansiCyan / DSH 深青），亮底主题要压深到白字 ≥4.5:1。`theme-tokens.test.js` 校验 token 存在、对比度、`--color-ask` 不等于 `--color-accent`，以及侧栏不再出现 `bg-accent chat-dot-unread` 组合。

## 界面审查清单（新增页面、面板、弹窗必查）

- 顶部临时提示走 `renderer/src/notify.js` + `NotificationHost.jsx`：`notify({ key, text, detail, level, timeout, actions })`，同 key 原地更新，最多三条，`sticky` 置顶；需要「页面刷完再提示」用 `queueAfterReload`。不要另外写浮层。

- 控件只用 `@mica-config-ui/web` 那一套（`Button` / `Tag` / `Alert` / `Empty` / `Switch` / `Checkbox` / `SelectMenu` / `DateField` / `Segmented` / `Input` / `InputNumber`），原生 `<select>`、`type="date"`、`type="checkbox"` 一律不用——`web/noNativeControls.test.ts` 按源码挡住，插件页面同样在范围内。
- Arco 基础样式通过 `body.mica-arco-theme` 覆盖完整应用及 Portal；设置页布局样式仍限定在 `@scope (.mica-config-ui)`。不要把整个 App 包进 `.mica-config-ui`（它带整页尺寸与配色）；内嵌设置布局才套 `mica-config-ui is-embed`。
- 快捷按钮的外观验收页是 `?quick-buttons-demo=1`（`renderer/src/QuickButtonsPreviewDemo.jsx`），按钮与实际快捷栏共用 `ShortcutButton`（外观规格来自 `quickbarButtonLook`）、卡片用 `PluginPanels.jsx` 的 `QuickbarPreview`——演示页只提供「模拟对话 + 模拟输入条」的壳，不复制任何按钮或卡片样式，否则两边迟早长得不一样。它是纯静态页，在 `ensureMicaApi()` 之前渲染，可以挂在任意静态服务下看。
- 快捷按钮预览使用共享 `ArcoPopover` 的定位、边框、圆角、阴影和排版，不再叠加旧卡片皮肤或 `.mica-config-ui` 主题壳。其它 Portal 到 `body` 的自绘浮层要自己声明 `font-size` / `line-height`：不声明就继承 `body` 的 16px，正文会比它自己的标题还大。浮层的排版按 `.chat-tooltip` 那一档来（`calc(var(--chat-text-size) - 1px)`、1.55、圆角 10px、130ms 位移 2px 入场），并给 `prefers-reduced-motion` 关掉动画；纯文本分支保留换行（`white-space: pre-line`），Markdown 分支要抹平 `.chat-markdown` 自带的字号行高，否则同一张卡片换个写法就换一套排版。
- 预览卡片里只有正文用对话区的等宽字体，标题、说明与动作跟随界面字体；标题与副标题排成一行（副标题太长自然折行），字号分别取弹窗标题档 12.5/600 与浮层说明档 `calc(var(--chat-text-size) - 2px)`。动作区只有主操作带底（`--color-accent-subtle` 淡强调底 + 强调色文字），其余是文字按钮——一排同重量的实心块会盖过标题和正文，谁是真的下一步看不出来。
- `app.css` 认识的状态色是 `--color-success` / `--color-warn` / `--color-danger` / `--color-accent`（明暗各一套）；`--green` / `--amber` / `--red` / `--blue` 只在组件库 `web/styles.css` 的 `.mica-config-ui` 作用域内定义，在 `app.css` 里引用它们等于没写，`color` 会静默落回继承——写状态色时先确认变量属于哪份表。
- 选中态不要用 `border-left` 或 `inset ... 0 0` 造竖直亮条，用背景、圆角边框与字重区分。
- 一行里的控件必须等高：原生 select / checkbox 要么 `appearance: none` 自绘，要么用共享组件。
- 禁用态只掉颜色，尺寸、边框与位置不变。
- 共享 `Button` 只在 `icon` / `loading` 存在时才输出图标格。
- 图标与文字横排规则覆盖作用域内所有 `.arco-btn`（配置页也直接使用 Arco Button），不能只覆盖 `.ui-button`；桌面 Tailwind 会把 SVG 设为块元素，按钮必须使用单行 flex 布局。
- 整行按钮（图标 + 文字、`w-full` + `text-left`）要带 `mica-arco-row`：Arco 的 `.arco-btn` 居中与 `svg + span` 6px 左边距写在 layer 外，Tailwind 的 `justify-*` 压不住它，只有这条更高特异性的规则能把内容按回左边、把图标与文字间距交回 `gap`。
- 同一动作区的主次按钮统一高度；文字主按钮 `flex: none` + 不换行。
- 标签在控件上方，不要把说明词塞进控件行；复合控件放在同一条边框里。
- 条目列表不要靠 `padding-left` 造缩进，符号用 `li::before` 画在符号列里。
- 同一列的单位给固定宽度，避免每行步进按钮错位。
- 页签只有一种形态：统一复用 `.session-tabs` / `.session-tab` 的下划线样式。
- 开关用共享 `Switch`；枚举值经 `labels.ts` 映射成中文再上屏。
- 长文本单行省略并带 `title`（`min-width: 0` + `text-overflow: ellipsis`）。
- 说明文字只留一处；状态放到操作行或状态列。
- 页头路径由 `PageFrame` 收拢成「…/末三级目录/文件名」，完整路径留在 `title`。
- 行内动作按钮用 `variant="ghost"`，破坏性的用 `variant="danger-ghost"`（红字、不画常态边框）；列表行按钮写 `width: 100%`。
- 不要把字段逐个包成卡片；设置项用 `SettingsGroup` + `SettingRow`，列表/详情用 `SplitView`。

## 移动端

- <768px 单栏 + 会话抽屉，Files 树/编辑器切换；`?layout=mobile|desktop` 可预览。
- safe-area 处理；表单字号至少 16px（Monaco 除外）。
- 根高度取 visual viewport / innerHeight / clientHeight 中明显更小的信号，保持 `--vvh-top` 补偿。
- `TerminalKeyBar` 经 `term.input()`；xterm 使用 DOM 渲染器，字号/颜色走 options。
- xterm 软键盘补发仅覆盖空格与 A–Z，须 preventDefault；上游 #5614 仍处于 closed（未合并）状态，`@xterm/xterm` 6.0.0 仍会丢这些 input，删除前必须在真机复验。

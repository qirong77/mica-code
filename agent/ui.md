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
- Web 基础控件以 Arco Design React 为实现：`Ui.tsx` 保留共享语义接口，`SelectMenu` / `DateField` / `Modal` / `DataTable` 适配原有业务契约，普通输入从共享入口引入 `Input` / `InputNumber`，动作菜单复用 `MenuList` / `MenuItem` / `MenuSeparator`（定位与开合交给调用方，共享表面、行样式及键盘导航）。`ArcoProvider` 供完整 App 统一配置语言、尺寸与弹层容器；`ArcoAction` 透传原生按钮事件与 ref。标准表单使用 Arco `small`（28px / 14px），密集工具栏使用 `mini`（24px / 12px）；不按设置页容器重写基础控件高度，20/22px 纯图标动作保留业务特例。设置骨架圆角采用 2 / 4 / 8 / 12px 阶梯。`arco-settings.css` 按需载入控件样式，在 `body.mica-arco-theme` 与 `.mica-config-ui` 映射主题；页面旧控件皮肤不得覆盖 Arco。保留页面骨架、导航、布局与专用编辑器，不另写第二套基础控件。
- 纯图标动作显式传 `iconOnly`，共享适配层用双轴居中，禁止沿用文字内边距；文字动作继承所在工具栏字号与字色，状态色仍交给 Arco。普通导航、工具栏与文字动作使用当前主题的中性色，不套 Arco 默认蓝色；主操作与选中态才使用主题强调色，危险/成功/警告保留语义色。主题沿用现有六套与 `auto`，组件及 body Portal 通过同一份 token 映射即时更新。
- 折叠按容器宽度（`@container page (max-width: 860px)`），不按视口。
- Config 页只按字段编辑 providers；`mcpServers` 与 `capabilityDefaults` 不在这页编辑——前者在 MCP 页按字段填，后者跳到 Capabilities 页。
- MCP 页没有左列表：`mcpServers` 的协议与字段是固定的，一页就一个 `SettingsGroup`，一个 server 一张可折叠的 `entry-row`（与服务商同一套行），折叠行显示名称 / 连接方式 / 命令或地址 / 连接状态，展开接字段行。类型用 `Segmented`，本地进程填命令 / 参数 / 环境变量 / 工作目录 / 标准错误，HTTP 填地址 / 请求头；切类型会删掉另一侧的已知键（文件里同时留着 `command` 与 `url` 的条目说不清是哪种）。连接状态与工具列表只属于磁盘上那份配置，类型换掉后不再显示。右上角「编辑 JSON」是**整份** `mcpServers`（也接受文档里抄来的 `{ "mcpServers": { … } }`），与表单是同一份内容的两种形态；转换唯一实现是 `web/mcpDraft.ts`。
- MCP 的读写都走整份：`readMcpDetails` 返回文件里的 `mcpServers` 原文（`content`，不展开 `${VAR}`——按展开后的值写回去会把占位符换成这一台机器的端口），保存是 `writeMcpServers(content)` 一次写整份。逐条写会把改名 / 删除拆成两次请求。
- 服务商在分组里是一行：折叠显示 id（唯一的名称，不再另设显示名称）/协议/地址/模型数，展开接字段行；有错误强制展开并标「待修正」。模型列表全靠手填（没有「模型列表地址」），展开体最后一行是「测试连接」：它用页面上当前的地址 / Key / 协议 / 第一个模型发一次最小请求，结论就写在按钮右边。
- Sessions 左栏的会话信息由 `src/server/sessionHead.ts` 只读文件头 8KB 解析，两个宿主共用。
- Roles 保持左列表 + 右编辑器：`default` 保留选择，明确标为「默认系统提示词」，正文只读且可复制；选择它不重复追加。自定义 Role 只编辑追加正文，页面说明它位于默认正文之后、同属系统提示词，不替换默认正文。两个宿主都拒绝创建、写入、删除 `default` 及其大小写 / `.md` 后缀 / 首尾空白别名。
- 会话提示词有 `snapshot.systemPrompt` 时以存档为准；没有记录时，对话与 Context 分析只以「当前默认正文 + Role 追加正文」作展示参考，不写回快照。系统提示词页仍明确显示「没有记录」，参考内容不冒充当时发出的完整提示词。
- 浏览器侧（`web/`）只能 import 纯子模块：`mica-plugin` / `mica-common` 的包入口会顺带导出读写文件的模块，dev 下整页白屏且 tsc 与单测都看不出来（`web/browserImports.test.ts` 静态挡住）。
- 密钥类输入统一用 `web/components/SecretInput.tsx`：默认密文 + 眼睛按钮切明文，明文状态在组件内，收起或换页自动回到密文。
- 配置页不提供 effort 开关：由模型规则按模型名决定。
- 表单转换唯一实现 `web/configDraft.ts`；写入保留未知键，已知键固定顺序，可选字段留空即删键。MCP 页同理（`web/mcpDraft.ts`）。
- Capabilities 页分「当前会话 / 默认配置」，包含 Tools / Skills / MCP / Plugins / 提示词控制：默认值读写仍在 `src/server/capabilityDefaults.ts`，静态目录合并插件清单与已发布技能；当前会话由 `ConfigWebApp.capabilitiesRuntime` 接到该会话的 `mica/capabilities/get|set`，展示实际注册工具、技能归属与完整 schema。没有会话宿主时明确提示无法读取动态正文。与会话设置共用的能力列表中，单项组直接平铺，多项组保留组头与整组开关。
- 提示词控制复用 `SplitView` 与共享编辑器：左侧按来源逐段开关，右侧自动保存正文覆盖、查看原文与恢复原文；Plugins 页签可整插件关闭注入。全局控制存 `prompt-controls.json`，不改插件文件或存档，下一轮开始生效。固定 system 始终只读；「下一轮预览」与「最近实际发送」分开，预览不能改写 `snapshot.systemPrompt`。
- 插件页是「目录 + 整页详情」：目录首个页签是「全部」，其后按已声明的桌面能力 / 可配置能力 / 其他工具 / 用户来源切换卡片网格（停用的卡片压暗），每张卡显示清单 `icon`（`web/pluginIcons.tsx` 的映射表，未登记回落 `puzzle`）与一枚启停开关（卡片是「外壳 + 打开详情的按钮 + 右上角的开关」，开关不能塞进按钮里）；点开进入单插件详情页，返回走详情页自己的返回行。**开关是唯一的启停控件**：卡片脚注与详情页信息表的「加载」行只说装配结论（已加载 / 已跳过 / 加载失败 / 尚未加载，停用时是「已停用」），不要再放一枚「已启用」标签去重复开关的语义（唯一实现在 `pluginRunningStatus()`）。清单 icon 不参与内核逻辑，只在配置页呈现。
- 详情页右侧信息表只有标识 / 加载 / 目录 / 日志四行、单行省略；「日志」是路径链接（单击选「在 Finder 中打开 / 在 Mica 中打开」，⌘ 点击直接进编辑器，用的是 `PathLink` + 宿主的 `revealPath` / `openPathInEditor`），目录那行不是——官方插件的目录是仓库里的相对路径。插件里的文件清单不进界面（`PluginInspection` 不读目录），用户要的是「装没装上」而不是文件浏览器。
- 插件设置在详情页按清单渲染：开关用共享 `Switch`，数字用 Arco `InputNumber` 的按钮模式，单位定宽；手输草稿不夹值，步进才按边界归一，校验与落盘规则不变。
- 所有页面不设保存按钮：`useAutoSave`（400ms 防抖、串行写盘、卸载补发）；校验不过不写盘。
- 新建/删除/放弃用 `DialogHost` 的 confirmDialog / promptDialog。
- 共享 Modal 的 inline / body Portal 都保留 Arco 的 focusLock 与 autoFocus，不叠加 DOM-only Tab 陷阱、不延迟强抢关闭按钮；最上层弹窗卸载后待焦点锁注销再恢复 opener，输入框 autofocus 不被覆盖。
- 配置页产物由用户决定何时生成：明确要求构建时跑 `bun run build:config-web` 并更新 `generatedStaticAssets.ts`；日常源码改动不自动构建或重启。
- 样式限定 `.mica-config-ui`；桌面 app.css 与配置页共用 Darcula 暗色 token；页面级 html/body 高度链归宿主。

## 主题（6 套主题 + 跟随系统）

- 主题是默认能力：「跟随系统 / Darcula / 浅色 / Catppuccin Mocha / Catppuccin Latte / Tokyo Night / Tokyo Night Light」，设置在 Settings → Appearance（偏好存运行时界面状态 `theme`，默认 `auto`）。注册表只有一份：`packages/mica-web-shared/theme.ts` 的 `THEMES`（id / 明暗档 / 画布色 / 同源配对的另一档）；`apps/desktop/src/renderer/src/theme.js` 是渲染层唯一入口，切换只改 `<html data-theme>` 与 `data-appearance`，不重载页面。
- `<html data-theme='<id>'>` 选具体主题，`<html data-appearance='light|dark'>` 只表达亮/暗——所有「亮底要单独处理」的规则（阴影权重、查找条输入框、屏幕涂层）都挂在 `data-appearance` 上，新增主题自动继承，别按主题 id 再写一遍。
- 颜色只用 `--color-*` / `.mica-config-ui` 容器变量：默认暗色（Darcula）的取值在 `@theme` 与 `.mica-config-ui` 默认块里，其余每个主题一个 `html[data-theme='<id>']` 块。**加主题 = 注册表加一项 + 各宿主补一个块**：桌面 `assets/app.css`、设置页 `packages/mica-config-ui/web/styles.css`（含主题卡预览色板）、终端窗口 `renderer/src/terminal-page.css`、xterm 表 `renderer/src/terminal-theme.js`、monaco 主题（`monaco-runtime.js` 用 `--color-*` 的镜像值）。`theme-tokens.test.js` / `appearance-tokens.test.ts` / `theme-boot.test.js` 会逐个主题拦住漏掉的那处。
- 第三方主题的取值走**上游原始调色板**，不照着截图调：Catppuccin 取自官方 `palette.json`（`mocha` / `latte` 的 `colors` + `ansiColors`），Tokyo Night 取自 `enkia/tokyo-night-vscode-theme` 的 theme JSON。亮底主题的 ANSI 彩色若在上游画布上不够 4.5:1（Catppuccin Latte 的绿/黄/品红就是），按同一色相压暗后再落地，并在块里写一行注释说明——别直接抄上游导致终端输出糊在浅底上。
- 亮色的取值**逐档取自 DeepSeek harness 开源仓库**（`deepseek-ai/deepseek-harness` 的 `packages/client/ui-theme/src/styles/design-platform.css`：`--dsw-static-neutral-bluish-*` 调色板 + `--dsw-alias-*` 语义层；对话各层的用法看 `packages/client/ui-chat/src/client/chat/*.module.css`），保留其基础色板与产品表面，文字可读性和控件状态以 Mica 的语义适配为准，不要求逐值复刻；要核对来源就 `dsh web` 起一份真界面读计算样式。改亮色前先看那份文件的语义：正文、菜单、标题都是 `label-primary`（neutral-bluish-1000 近黑，不是中灰；亮色顶端两档因此并成同一个值），过程文字（工具行/思考）使用可读的 `label-secondary`（neutral-bluish-700），辅助时间等信息退到 `label-tertiary`（neutral-bluish-600），用户消息带是 `--dsw-specific-bubble`（deepseek-50 淡蓝），行内代码是 `markdown-inline-code`（浅底 + `border-l1` 描边），面板是 `neutral-bluish-50`，选中行是 `neutral-bluish-100`（= `--color-active`，会话行/导航/文件树都用它，不要用洗色层凑），洗色层是带蓝调的 `rgba(38 49 72, α)`。
- Arco 的 `color-text-3`（提示/次要信息）与 `color-text-4`（禁用值）分别映射；浅色设置说明取可读灰，禁用值在适配层由前景与画布混合。品牌链接蓝保留，实心主按钮另由 `--mica-arco-accent-solid` 加深以保证白字可读；普通确认/输入对话框的确定动作使用共享 Button 的 `accent`，不是表示当前项的 `primary`。
- 因此亮色有五个专属 token 不能回退成通用灰阶：`--color-nav-fg`（侧栏/菜单行）、`--color-bubble`（用户消息带）、`--color-inline-code{,-bg,-border}`（行内代码药丸）、`--color-heat-empty`（热力图空格：亮色 canvas 是纯白，铺在 panel 卡片上等于没有网格）。`theme-tokens.test.js` 钉住了这些锚点，值要改就一起改测试并写明理由。
- 提问（`ask` 插件）有一支**自己的识别色** `--color-ask` + 压在它实心底上的字色 `--color-ask-contrast`：卡片问号徽标、选中选项、「确定」按钮、输入框聚焦边框，以及侧栏/快速打开里「等你做一个选择」的圆点全用它。**不要退回主题强调色**——强调色在浅色主题里就是蓝色，会和未读蓝点、主按钮混在一起，一笔等你点选的卡片就认不出来。六个主题各取自家调色板的青（Darcula ansiCyan / Catppuccin teal / Tokyo Night ansiCyan / DSH 深青），亮底主题要压深到白字 ≥4.5:1。`theme-tokens.test.js` 校验 token 存在、对比度、`--color-ask` 不等于 `--color-accent`，以及侧栏不再出现 `bg-accent chat-dot-unread` 组合。

## 动效

- 全站一套 token：`assets/app.css` 的 `@theme` 里定义 `--default-transition-duration` / `--default-transition-timing-function`（Tailwind 的 `transition-*` 工具类默认取这两项，JSX 里已有的 `transition-colors` 因此自动跟随）与 `--ease-soft` / `--ease-emphasized` / `--ease-exit`；`:root` 里定义 `--motion-fast`（90ms，按压与悬浮）/ `--motion-base`（140ms，浮层与切页）/ `--motion-slow`（200ms，整块入场）。
- 入场只写在一个地方：`app.css` 末尾的「动效」段。`@keyframes motion-pop-in`（浮层，4px + 0.98）、`motion-rise-in`（切页与卡片，5px）、`motion-toast-in`（顶部通知）、`motion-fade-in`（设置页、终端面板）。新面板要入场就在那里加它的类名，别在组件文件里另写 keyframes。
- 入场靠 `animation` 而不是 `transition`：元素挂载即播，`display: none → flex` 切回可见时也会重播，所以 `App.jsx` 里那些常驻实例（对话 / 统计 / 文件靠 `visible` 切 display）不需要 JS 配合。除了折叠（见下一条），退场一律不做——退场要留 DOM 等动画跑完，每处卸载都得改成延迟卸载，代价大于收益。
- **折叠 / 展开只用 `renderer/src/Collapse.jsx`**，不要各写一套 `max-height` 或量高度：它用 `grid-template-rows: 0fr ↔ 1fr` 让浏览器自己解算内容高度（`app.css` 的 `.motion-collapse`），收起时延迟 160ms 再卸载内容，展开时先以 0fr 挂上一帧再放开。树（文件树目录、会话分组、Git 面板根）、侧栏分区、回合日志都走它；给新面板加折叠时包一层 `<Collapse open={...}>` 即可。收起过程中内容带 `aria-hidden` 且不接收点击。文件树的懒加载依赖「收起时内容不挂载」，别把 `Collapse` 换成常驻 DOM。
- 可旋转的箭头（`rotate-90` 切换）要带 `transition-transform`：Tailwind v4 把 `rotate-90` 编译成独立的 `rotate` 属性，而 `transition-transform` 的 `transition-property` 含 `rotate`，两者才配得上；只写 `rotate-90` 是瞬间翻转。
- 页签 / 筛选切换后的内容用 `.motion-swap-in`（淡入 + 抬 3px，140ms）：统计页的会话明细、模型明细各带一份。它只在元素**新挂载**时播——同类型元素复用同一个 DOM 节点时不会重播，所以换内容的分支要真正换组件或加 `key`。
- 图表里的数据条用 `.motion-bar`（从 `scaleX(0)` 长到目标宽度，200ms；右对齐的底纹条用 `.motion-bar-right`）。目标宽度仍然由行内 `style` 给出，动画只负责「从没有到有」；不要改成过渡 `width`，一屏几十条会逐帧重排。
- 列表行、树行、菜单项、页签的悬浮 / 选中 / 拖拽变淡由 `app.css` 里 `[role='treeitem']` / `option` / `menuitem` / `tab` 的统过渡覆盖（90ms），新树行只要写对 `role` 就自动有；不要给每行再加一遍 `transition-colors`。
- 只动 `opacity` / `transform` / 颜色。宽高、位置、间距不参与过渡：终端面板高度、侧栏宽度、对话滚动位置都由 JS 量出来写进样式，过渡它们会在量到的瞬间打架（xterm 只淡入、不做位移）。
- 浮层的 `transform-origin` 跟着锚点：`.chat-popover` 是 bottom right，`.chat-command-palette` 是 bottom center，`.quick-pick-panel` 是 top center。统一成 center 会让它们像从中间弹出来。
- 按压反馈只给 `.arco-btn:not(.mica-arco-row)`：整行按钮缩一下会让整行文字跟着抖，那种场景本来就是背景色在反馈。
- 统计页的卡片入场（`.stats-panel` + `.stats-modules` / `.stats-overview` 的 `:nth-child` 28ms 步进）写在 `stats/stats.css`，keyframes 仍取 `app.css` 的 `motion-rise-in`。
- 弹窗动效收在 `arco-settings.css` 末尾：Arco 默认 400ms、从 0.5 倍带 1.3 过冲，改成 200ms 软曲线、从 0.96 起。Arco 的规则在 `layer(mica-arco)` 里，覆盖它的规则写在分层之外，不需要 `!important`。
- 配置页（`packages/mica-config-ui/web/styles.css`）不加载 `app.css`，拿不到 `--motion-*`：那里的时长与曲线写同一条曲线的字面量 `cubic-bezier(0.22, 1, 0.36, 1)`。
- `prefers-reduced-motion: reduce` 有一条全局兜底（`app.css` 动效段末尾），把动画与过渡压到 1ms 并清掉延迟；新增动效不用各自再写一次。

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
- 整行按钮（图标 + 文字、`w-full` + `text-left`）要带 `mica-arco-row`：Arco 的 `.arco-btn` 居中与 `svg + span` 6px 左边距写在 layer 外，Tailwind 的 `justify-*` 压不住它，只有这条更高特异性的规则能把内容按回左边、把图标与文字间距交回 `gap`。**浮层/菜单里的整行按钮同样要带**——它一旦继承动作条那层淡字色（`.chat-composer-actions` 的 22%），整列菜单看起来就像全被禁用了；容器显式给回 `var(--color-fg)`。
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

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
- 折叠按容器宽度（`@container page (max-width: 860px)`），不按视口。
- Config 页只按字段编辑 providers；`mcpServers`、`capabilityDefaults` 只读展示并跳到各自页面。
- 服务商在分组里是一行：折叠显示 id（唯一的名称，不再另设显示名称）/协议/地址/模型数，展开接字段行；有错误强制展开并标「待修正」。
- Sessions 左栏的会话信息由 `src/server/sessionHead.ts` 只读文件头 8KB 解析，两个宿主共用。
- 浏览器侧（`web/`）只能 import 纯子模块：`mica-plugin` / `mica-common` 的包入口会顺带导出读写文件的模块，dev 下整页白屏且 tsc 与单测都看不出来（`web/browserImports.test.ts` 静态挡住）。
- 密钥类输入统一用 `web/components/SecretInput.tsx`：默认密文 + 眼睛按钮切明文，明文状态在组件内，收起或换页自动回到密文。
- 配置页不提供 effort 开关：由模型规则按模型名决定。
- 表单转换唯一实现 `web/configDraft.ts`；写入保留未知键，已知键固定顺序，可选字段留空即删键。
- Capabilities 页改 `config.capabilityDefaults`，读写实现在 `src/server/capabilityDefaults.ts`。
- 插件页是「目录 + 整页详情」：目录按官方 / 用户分组渲染卡片网格（停用的卡片压暗），每张卡显示清单 `icon`（`web/pluginIcons.tsx` 的映射表，未登记回落 `puzzle`）与一枚启停开关（卡片是「外壳 + 打开详情的按钮 + 右上角的开关」，开关不能塞进按钮里）；点开进入单插件详情页，返回走详情页自己的返回行。**开关是唯一的启停控件**：卡片脚注与详情页信息表的「加载」行只说装配结论（已加载 / 已跳过 / 加载失败 / 尚未加载，停用时是「已停用」），不要再放一枚「已启用」标签去重复开关的语义（唯一实现在 `pluginRunningStatus()`）。清单 icon 不参与内核逻辑，只在配置页呈现。
- 详情页右侧信息表只有标识 / 加载 / 目录 / 日志四行、单行省略；「日志」是路径链接（单击选「在 Finder 中打开 / 在 Mica 中打开」，⌘ 点击直接进编辑器，用的是 `PathLink` + 宿主的 `revealPath` / `openPathInEditor`），目录那行不是——官方插件的目录是仓库里的相对路径。插件里的文件清单不进界面（`PluginInspection` 不读目录），用户要的是「装没装上」而不是文件浏览器。
- 插件设置在详情页按清单渲染：开关用共享 `Switch`，数字用 `config-stepper`（−/输入/+ 共用一条边框，单位定宽）。
- 所有页面不设保存按钮：`useAutoSave`（400ms 防抖、串行写盘、卸载补发）；校验不过不写盘。
- 新建/删除/放弃用 `DialogHost` 的 confirmDialog / promptDialog。
- 改配置页后跑 `bun run build:config-web` 并提交 `generatedStaticAssets.ts`。
- 样式限定 `.mica-config-ui`；桌面 app.css 与配置页共用 Darcula 暗色 token；页面级 html/body 高度链归宿主。

## 主题（浅色 / 深色 / 跟随系统）

- 主题是默认能力：桌面 UI 支持 浅色 / 深色 / 跟随系统，设置在 Settings → Appearance（偏好存运行时界面状态 `theme`，默认 `auto`，`apps/desktop/src/renderer/src/theme.js` 是渲染层唯一入口）。颜色只用 `--color-*` / `.mica-config-ui` 容器变量：暗色值在 `@theme`（Darcula），亮色值在 `html[data-theme='light']` 覆盖块；切换只改 `data-theme` 属性，不重载页面。xterm / monaco 读不到 CSS 变量，必须订阅 `theme.js` 的 `subscribeTheme` 同步 options/主题。
- 亮色的取值**逐档取自 DeepSeek harness 开源仓库**（`deepseek-ai/deepseek-harness` 的 `packages/client/ui-theme/src/styles/design-platform.css`：`--dsw-static-neutral-bluish-*` 调色板 + `--dsw-alias-*` 语义层；对话各层的用法看 `packages/client/ui-chat/src/client/chat/*.module.css`），不是照着截图调出来的，要核对就 `dsh web` 起一份真界面读计算样式。改亮色前先看那份文件的语义：正文、菜单、标题都是 `label-primary`（neutral-bluish-1000 近黑，不是中灰；亮色顶端两档因此并成同一个值），过程文字（工具行/思考/时间戳）是 `label-tertiary`（neutral-bluish-600），用户消息带是 `--dsw-specific-bubble`（deepseek-50 淡蓝），行内代码是 `markdown-inline-code`（浅底 + `border-l1` 描边），面板是 `neutral-bluish-50`，选中行是 `neutral-bluish-100`（= `--color-active`，会话行/导航/文件树都用它，不要用洗色层凑），洗色层是带蓝调的 `rgba(38 49 72, α)`。
- 因此亮色有五个专属 token 不能回退成通用灰阶：`--color-nav-fg`（侧栏/菜单行）、`--color-bubble`（用户消息带）、`--color-inline-code{,-bg,-border}`（行内代码药丸）、`--color-heat-empty`（热力图空格：亮色 canvas 是纯白，铺在 panel 卡片上等于没有网格）。`theme-tokens.test.js` 钉住了这些锚点，值要改就一起改测试并写明理由。

## 界面审查清单（新增页面、面板、弹窗必查）

- 顶部临时提示走 `renderer/src/notify.js` + `NotificationHost.jsx`：`notify({ key, text, detail, level, timeout, actions })`，同 key 原地更新，最多三条，`sticky` 置顶；需要「页面刷完再提示」用 `queueAfterReload`。不要另外写浮层。

- 控件只用 `@mica-config-ui/web` 那一套（`Button` / `Tag` / `Alert` / `Empty` / `Switch` / `Checkbox` / `SelectMenu` / `DateField` / `Segmented` / `text-input`），原生 `<select>`、`type="date"`、`type="checkbox"` 一律不用——`web/noNativeControls.test.ts` 按源码挡住，插件页面同样在范围内。
- 选中态不要用 `border-left` 或 `inset ... 0 0` 造竖直亮条，用背景、圆角边框与字重区分。
- 一行里的控件必须等高：原生 select / checkbox 要么 `appearance: none` 自绘，要么用共享组件。
- 禁用态只掉颜色，尺寸、边框与位置不变。
- 共享 `Button` 只在 `icon` / `loading` 存在时才输出图标格。
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

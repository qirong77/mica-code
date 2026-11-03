/**
 * 配置页的宿主入口。
 *
 * 宿主（浏览器页面 / 桌面端设置视图）要先 `setConfigWebClient()` 与 `setConfigWebEditor()`
 * 注册自己的实现，再渲染 `ConfigWebApp`。样式随本模块一起加载（`styles.css`），
 * 全部限定在页面自己渲染的 `.mica-config-ui` 容器内。
 */
import './styles.css';

export { App as ConfigWebApp } from './App.js';
export type { ConfigWebAppProps } from './App.js';
export { setConfigWebClient } from './api.js';
export type { ConfigWebClient } from './api.js';
/** 会话快照的宿主数据读取：桌面端的耗时弹窗按需自己取一次落盘记录。 */
export { readSessionDetails } from './api.js';
export { setConfigWebEditor } from './editor.js';
export type { ConfigWebEditor, ConfigWebEditorProps } from './editor.js';
/**
 * 可替换的文本编辑器（桌面端是本地 monaco，浏览器退回朴素文本域）。
 *
 * 插件卡片要一段能编辑 markdown / JSON 的正文时用它：宿主注册的那份实现与设置页
 * 是同一个，主题、字体与光标行为都一致。
 */
export { JsonEditor } from './components/JsonEditor.js';
export type { ConfigWebSection } from '../src/shared/types.js';

/**
 * Appearance 页签的主题能力由宿主注册（桌面宿主存运行时界面状态，浏览器宿主存
 * localStorage）。没注册时这一页不出现在导航里——见 `hasConfigWebThemeHost`。
 */
export { hasConfigWebThemeHost, setConfigWebThemeHost, useThemePreference, THEME_OPTIONS } from './theme.js';
export type { ConfigWebThemeHost, ThemeOption, ThemePreference } from './theme.js';

/**
 * 会话级设置（桌面端会话设置弹窗）复用同一批控件：
 * 能力列表与开关。宿主把它们包在 `.mica-config-ui is-embed` 里，
 * 就能拿到与设置页完全一致的形态，不用另写一套。
 */
export { CapabilityList, CapabilityParameters } from './components/CapabilityList.js';
export type { CapabilityGroupDef, CapabilityItem, CapabilityParameter } from './components/CapabilityList.js';
export { applyGroupEnabled, buildCapabilitySections } from './capabilityGroups.js';
export type { CapabilityGroupRef, CapabilitySection } from './capabilityGroups.js';
export { Switch, Switch as ConfigSwitch } from './components/Ui.js';
export { SettingRow, SettingsGroup } from './components/Ui.js';
/** 密钥输入（默认密文 + 眼睛切明文）：服务商 Key、插件设置与插件面板共用一份。 */
export { SecretInput } from './components/SecretInput.js';
/**
 * 基础控件：桌面端的插件面板等宿主界面与设置页共用这一套，同一个应用里不会出现
 * 三种按钮高度、两套状态色。用它们时必须包在 `.mica-config-ui` 容器里（样式都限定
 * 在该作用域内）。
 */
export { Alert, Button, Checkbox, CollapsiblePanel, Empty, Segmented, SplitView, Tag } from './components/Ui.js';

/**
 * 数据表：统计页的 By source / By session 与会话详情共用一份形态（表头可排序、按列宽
 * 摊开、底部翻页、窄容器先让次要列退场）。单元格内容由调用方渲染，所以进度条、按钮与
 * 纯文本都能进同一张表。
 */
export { DataTable } from './components/DataTable.js';
export type { DataTableColumn, DataTableSort } from './components/DataTable.js';
/** 二维码：插件弹窗里的手机链接这类「扫一下就走」的内容，编码与码样都只有这一份。 */
export { QrCode } from './components/QrCode.js';
export { pageRangeLabel, pageWindow } from './components/dataTableModel.js';

/**
 * 日期字段：可打字 + 自绘月历。
 *
 * 原生 `type="date"` 的日历弹层由系统绘制（位置、配色、关闭方式都不受页面控制），
 * 内嵌视图里会飘到控件外；排期这类大量日期输入的页面一律用这一份。
 */
export { DateField } from './components/DateField.js';

/** 单个插件设置字段的控件：插件详情与会话设置共用，保证两处控件一致。 */
export { PluginSettingInput } from './components/PluginSettingInput.js';

/**
 * 文件路径链接：点开选「在 Finder 中打开 / 在 Mica 中打开」，⌘ 点击直接进编辑器。
 *
 * 两个动作都由宿主注册（`ConfigWebClient.revealPath` / `openPathInEditor`）；
 * 浏览器宿主没有窗口可开，路径退回纯文本。
 */
export { PathLink } from './components/PathLink.js';

/**
 * 下拉的唯一实现：设置页与桌面端工具栏共用。
 *
 * 原生 `<select>` 的弹层由系统绘制，位置与样式不受页面控制，几百个分支时还会铺满
 * 整屏；这里一律用这一份（需要时打开过滤框、分组、紧凑尺寸）。
 */
export { SelectMenu } from './components/SelectMenu.js';
export type { SelectMenuOption } from './components/SelectMenu.js';
export { TurnTimingView } from './components/TurnTimingView.js';
export type { TurnTimingRound } from './components/TurnTimingView.js';

/**
 * 插件模型接口的配置面板：配置页与会话设置共用。
 *
 * 插件只声明清单里的 `llm`，两个宿主都渲染这一份——「复用当前会话模型」开关、
 * 隐藏独立配置、测试连接因此没有第二套实现。
 */
export { LlmSettingsSection } from './components/LlmSettingsSection.js';

/**
 * 插件图标表：桌面端的插件菜单与配置页的插件卡片读同一份，插件清单里的 `icon`
 * 因此在两个宿主里落到同一个图形上。
 */
export { PluginIcon, PLUGIN_ICONS, resolvePluginIcon } from './pluginIcons.js';
export type { PluginIconName } from './pluginIcons.js';

/**
 * 会话详情：桌面端的会话详情弹窗 / 上下文弹窗与配置页的 Sessions 页共用这一份，
 * 三个页签（对话记录 / Context 分析 / 原始文件）在各入口长得一样。
 */
export { SessionDetailView } from './components/SessionDetailView.js';
export type { SessionDetailExtraTab, SessionDetailTab } from './components/SessionDetailView.js';

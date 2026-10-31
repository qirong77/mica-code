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
export { setConfigWebEditor } from './editor.js';
export type { ConfigWebEditor, ConfigWebEditorProps } from './editor.js';
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
export { Switch as ConfigSwitch } from './components/Ui.js';
export { SettingRow, SettingsGroup } from './components/Ui.js';
/**
 * 基础控件：桌面端的插件面板等宿主界面与设置页共用这一套，同一个应用里不会出现
 * 三种按钮高度、两套状态色。用它们时必须包在 `.mica-config-ui` 容器里（样式都限定
 * 在该作用域内）。
 */
export { Alert, Button, CollapsiblePanel, Empty, Tag } from './components/Ui.js';

/** 单个插件设置字段的控件：插件详情与会话设置共用，保证两处控件一致。 */
export { PluginSettingInput } from './components/PluginSettingInput.js';

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

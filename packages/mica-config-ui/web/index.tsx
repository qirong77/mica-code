/**
 * 配置页的宿主入口。
 *
 * 宿主（浏览器页面 / 桌面端设置视图）要先 `setConfigWebClient()` 与 `setConfigWebEditor()`
 * 注册自己的实现，再渲染 `ConfigWebApp`。样式随本模块一起加载（`styles.css`），
 * 全部限定在页面自己渲染的 `.mica-config-ui` 容器内。
 */
import './styles.css';

export { App as ConfigWebApp } from './App.js';
export { setConfigWebClient } from './api.js';
export type { ConfigWebClient } from './api.js';
export { setConfigWebEditor } from './editor.js';
export type { ConfigWebEditor, ConfigWebEditorProps } from './editor.js';
export type { ConfigWebSection } from '../src/shared/types.js';

/**
 * 会话级设置（桌面端会话设置弹窗）复用同一批控件：
 * 能力列表与开关。宿主把它们包在 `.mica-config-ui is-embed` 里，
 * 就能拿到与设置页完全一致的形态，不用另写一套。
 */
export { CapabilityList, CapabilityParameters } from './components/CapabilityList.js';
export type {
  CapabilityGroupDef,
  CapabilityItem,
  CapabilityParameter,
} from './components/CapabilityList.js';
export { applyGroupEnabled, buildCapabilitySections } from './capabilityGroups.js';
export type { CapabilityGroupRef, CapabilitySection } from './capabilityGroups.js';
export { Switch as ConfigSwitch } from './components/Ui.js';
export { SettingRow, SettingsGroup } from './components/Ui.js';

/** 单个插件设置字段的控件：插件详情与会话设置共用，保证两处控件一致。 */
export { PluginSettingInput, nudgeSettingValue } from './components/PluginSettingInput.js';

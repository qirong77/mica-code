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

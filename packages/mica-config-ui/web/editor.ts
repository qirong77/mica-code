import type { ComponentType } from 'react';
import { PlainJsonEditor } from './components/PlainJsonEditor.js';

/**
 * 配置页里那个「文本编辑器」是可替换的部件。
 *
 * 页面本身需要的是「能编辑 JSON 的编辑器」，两个宿主给的实现不同：浏览器页面从 CDN 按需
 * 加载 monaco（@monaco-editor/react），桌面端用应用自带的本地 monaco（不联网、也不受
 * 页面 CSP 限制）。没注册时退回一个朴素文本域，页面不至于白屏。
 */
export type ConfigWebEditorProps = {
  value: string;
  language?: string;
  readOnly?: boolean;
  onChange(value: string): void;
};

export type ConfigWebEditor = ComponentType<ConfigWebEditorProps>;

let editor: ConfigWebEditor | null = null;

export function setConfigWebEditor(next: ConfigWebEditor | null): void {
  editor = next;
}

export function getConfigWebEditor(): ConfigWebEditor {
  return editor ?? PlainJsonEditor;
}

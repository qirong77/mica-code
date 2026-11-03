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
  /**
   * 把某一行滚到视野中央（只读查看长文时用）。
   *
   * 带上 `nonce` 是因为「再看一遍同一行」也要重新定位：只盯着 `line` 的话，反复点同一节
   * 不会回到那一行。宿主可以忽略它（朴素文本域就没有滚动定位能力）。
   */
  reveal?: { line: number; nonce: number } | null;
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

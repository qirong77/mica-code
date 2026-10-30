import Editor, { loader, type BeforeMount, type Monaco, type OnMount } from '@monaco-editor/react';
import type { ConfigWebEditorProps } from '@packages/mica-config-ui/web/index.js';

/**
 * 浏览器端（apps/config-web）的编辑器实现：monaco 从 CDN 按需加载，所以浏览器的配置页
 * 不必自带约 4MB 的编辑器产物。桌面端用应用自带的本地 monaco（见 apps/desktop），
 * 页面组件只认 `ConfigWebEditorProps`，两边互不影响。
 *
 * Monaco 读不到 CSS 变量，所以这里手工镜像 `packages/mica-config-ui/web/styles.css` 的
 * 两套 token；当前用哪套只跟 `<html data-theme>` 走——宿主切主题不重渲染 React，
 * 因此用 MutationObserver 监听属性变化，而不是把主题塞进组件 state。
 */
loader.config({
  paths: {
    vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs',
  },
});

const LIGHT_THEME = 'mica-light';
const DARK_THEME = 'mica-dark';

/** 浏览器宿主的主题落在 `<html data-theme>` 上；没有该属性时配置页仍是默认暗色。 */
function themeNameFromDocument(): typeof LIGHT_THEME | typeof DARK_THEME {
  return document.documentElement.getAttribute('data-theme') === 'light' ? LIGHT_THEME : DARK_THEME;
}

const beforeMount: BeforeMount = (monaco) => {
  // 暗色沿用 Darcula（config-ui 默认主题）。
  monaco.editor.defineTheme(DARK_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#3c3f41',
      'editorGutter.background': '#3c3f41',
      'editor.lineHighlightBackground': '#46484a',
      'editorLineNumber.foreground': '#606366',
      'editorLineNumber.activeForeground': '#999999',
      'editorCursor.foreground': '#a9b7c6',
      'editor.selectionBackground': '#214283',
      'editorIndentGuide.background1': '#434547',
      'editorIndentGuide.activeBackground1': '#5a5a5a',
      'editorWidget.background': '#46484a',
      'editorWidget.border': '#4b4b4b',
      'scrollbarSlider.background': '#4b4b4b66',
      'scrollbarSlider.hoverBackground': '#5a5a5a88',
      'scrollbarSlider.activeBackground': '#5a5a5aaa',
    },
  });

  // 亮色：白色内容面 + neutral-bluish 前景阶梯 + #4176e6 强调，与亮色覆盖块一致。
  monaco.editor.defineTheme(LIGHT_THEME, {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#ffffff',
      'editorGutter.background': '#ffffff',
      'editor.lineHighlightBackground': '#f1f3f5',
      'editorLineNumber.foreground': '#979da6',
      'editorLineNumber.activeForeground': '#61666b',
      'editorCursor.foreground': '#0f1115',
      'editor.selectionBackground': '#4176e633',
      'editorIndentGuide.background1': '#00000014',
      'editorIndentGuide.activeBackground1': '#00000029',
      'editorWidget.background': '#ffffff',
      'editorWidget.border': '#0000001a',
      'scrollbarSlider.background': '#00000029',
      'scrollbarSlider.hoverBackground': '#0000003d',
      'scrollbarSlider.activeBackground': '#00000052',
    },
  });

  // 建编辑器之前先对齐全局主题，避免首帧用错颜色。
  monaco.editor.setTheme(themeNameFromDocument());
};

let themeObserver: MutationObserver | null = null;

/** 只观察 `data-theme` 一个属性：切换主题不销毁编辑器，已开着的编辑器也要立刻换色。 */
function bindDocumentTheme(monaco: Monaco) {
  monaco.editor.setTheme(themeNameFromDocument());
  if (themeObserver) return;
  themeObserver = new MutationObserver(() => monaco.editor.setTheme(themeNameFromDocument()));
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
}

// @monaco-editor/react 的 theme prop 默认是 'light'，创建编辑器时会把全局主题拉回去；
// 这里显式传当前主题，并在 onMount 再对齐一次（创建期间主题可能已经变了）。
const onMount: OnMount = (_editor, monaco) => {
  bindDocumentTheme(monaco);
};

export function MonacoJsonEditor({ value, language = 'json', readOnly = false, onChange }: ConfigWebEditorProps) {
  return (
    <Editor
      height="100%"
      language={language}
      theme={themeNameFromDocument()}
      beforeMount={beforeMount}
      onMount={onMount}
      value={value}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontSize: 13,
        lineHeight: 21,
        scrollBeyondLastLine: false,
        padding: { top: 14, bottom: 14 },
        wordWrap: 'on',
        automaticLayout: true,
        smoothScrolling: true,
        overviewRulerBorder: false,
        hideCursorInOverviewRuler: true,
        scrollbar: {
          verticalScrollbarSize: 10,
          horizontalScrollbarSize: 10,
        },
      }}
      onChange={(next) => onChange(next ?? '')}
    />
  );
}

import Editor, { loader, type BeforeMount } from '@monaco-editor/react';
import type { ConfigWebEditorProps } from '@packages/mica-config-ui/web/index.js';

/**
 * 浏览器端（apps/config-web）的编辑器实现：monaco 从 CDN 按需加载，所以浏览器的配置页
 * 不必自带约 4MB 的编辑器产物。桌面端用应用自带的本地 monaco（见 apps/desktop），
 * 页面组件只认 `ConfigWebEditorProps`，两边互不影响。
 */
loader.config({
  paths: {
    vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs',
  },
});

const beforeMount: BeforeMount = (monaco) => {
  // Monaco cannot read CSS custom properties, so this mirrors the Darcula tokens
  // from the package's web/styles.css by hand. Keep it in sync when the palette changes.
  monaco.editor.defineTheme('mica-dark', {
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
};

export function MonacoJsonEditor({ value, language = 'json', readOnly = false, onChange }: ConfigWebEditorProps) {
  return (
    <Editor
      height="100%"
      language={language}
      theme="mica-dark"
      beforeMount={beforeMount}
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

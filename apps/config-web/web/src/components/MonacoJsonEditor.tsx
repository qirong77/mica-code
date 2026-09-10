import Editor from '@monaco-editor/react';
import { loader } from '@monaco-editor/react';
import type { BeforeMount } from '@monaco-editor/react';

loader.config({
  paths: {
    vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs',
  },
});

type MonacoJsonEditorProps = {
  value: string;
  language?: string;
  readOnly?: boolean;
  onChange(value: string): void;
};

const beforeMount: BeforeMount = (monaco) => {
  // Monaco cannot read CSS custom properties, so this mirrors the Darcula tokens
  // from src/styles.css by hand. Keep it in sync when the palette changes.
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

export function MonacoJsonEditor({ value, language = 'json', readOnly = false, onChange }: MonacoJsonEditorProps) {
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

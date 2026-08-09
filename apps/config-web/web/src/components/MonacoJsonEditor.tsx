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
  monaco.editor.defineTheme('mica-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#161616',
      'editorGutter.background': '#161616',
      'editor.lineHighlightBackground': '#1a1a1a',
      'editorLineNumber.foreground': '#555555',
      'editorLineNumber.activeForeground': '#9a9a9a',
      'editorCursor.foreground': '#eaeaea',
      'editor.selectionBackground': '#454545',
      'editorIndentGuide.background1': '#242424',
      'editorIndentGuide.activeBackground1': '#3a3a3a',
      'editorWidget.background': '#1e1e1e',
      'editorWidget.border': '#2a2a2a',
      'scrollbarSlider.background': '#3a3a3a66',
      'scrollbarSlider.hoverBackground': '#4a4a4a88',
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

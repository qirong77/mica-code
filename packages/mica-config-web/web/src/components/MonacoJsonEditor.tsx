import Editor from '@monaco-editor/react';

type MonacoJsonEditorProps = {
  value: string;
  language?: string;
  readOnly?: boolean;
  onChange(value: string): void;
};

export function MonacoJsonEditor({ value, language = 'json', readOnly = false, onChange }: MonacoJsonEditorProps) {
  return (
    <Editor
      height="100%"
      language={language}
      theme="vs"
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
      }}
      onChange={(next) => onChange(next ?? '')}
    />
  );
}

import type { ConfigWebEditorProps } from '../editor.js';

/** 没有宿主注册编辑器时的兜底：朴素的文本域，保证页面可用（两端都会注册真正的编辑器）。 */
export function PlainJsonEditor({ value, readOnly = false, onChange }: ConfigWebEditorProps) {
  return (
    <textarea
      className="json-editor-fallback"
      value={value}
      readOnly={readOnly}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

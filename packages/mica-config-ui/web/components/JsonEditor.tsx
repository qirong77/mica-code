import { getConfigWebEditor, type ConfigWebEditorProps } from '../editor.js';

/** 页面统一用这个组件，具体由宿主通过 setConfigWebEditor() 决定（见 editor.ts）。 */
export function JsonEditor(props: ConfigWebEditorProps) {
  const Editor = getConfigWebEditor();
  return <Editor {...props} />;
}

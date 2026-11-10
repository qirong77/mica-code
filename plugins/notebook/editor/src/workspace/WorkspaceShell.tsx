import {Button, Drawer} from '@arco-design/web-react';
import {IconList, IconSettings} from '@arco-design/web-react/icon';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {$getRoot} from 'lexical';
import {type ReactNode, useEffect, useState} from 'react';

import {useSettings} from '../playground/context/SettingsContext';
import Settings from '../playground/Settings';
import {useNotebookSession} from './NotebookBridge';
import {countCharacters} from './storage';
import WorkspaceOutline from './WorkspaceOutline';

export default function WorkspaceShell({children}: {children: ReactNode}) {
  const [editor] = useLexicalComposerContext();
  const session = useNotebookSession();
  const {settings, setOption} = useSettings();
  const [characters, setCharacters] = useState(0);
  const [sourceMode, setSourceMode] = useState('wysiwyg');
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const updateCharacters = () => setCharacters(editor.getEditorState().read(() => countCharacters($getRoot().getTextContent())));
    updateCharacters();
    const stop = editor.registerUpdateListener(({dirtyElements, dirtyLeaves}) => {
      if (!dirtyElements.size && !dirtyLeaves.size) return;
      updateCharacters();
      session?.dirty();
    });
    const sourceChanged = (event: Event) => {
      const mode = (event as CustomEvent<string>).detail;
      setSourceMode(mode);
      if (mode === 'wysiwyg') session?.dirty();
    };
    window.addEventListener('arco-editor-source-mode', sourceChanged);
    return () => { stop(); window.removeEventListener('arco-editor-source-mode', sourceChanged); };
  }, [editor, session]);

  return (
    <div className="workspace notebook-editor">
      <section className="editor-canvas" aria-label="笔记富文本编辑器">
        {children}
        <footer className="document-statusbar">
          <span role="status">{sourceMode === 'wysiwyg' ? `${characters.toLocaleString()} 字 · 输入 / 插入内容` : '源码模式 · 请返回富文本后保存或切换笔记'}</span>
          <span className="notebook-footer-actions">
            <Button size="mini" type="text" icon={<IconList />} onClick={() => setOption('showTableOfContents', !settings.showTableOfContents)}>大纲</Button>
            <Button size="mini" type="text" icon={<IconSettings />} onClick={() => setSettingsOpen(true)}>设置</Button>
          </span>
        </footer>
      </section>
      <Settings visible={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <Drawer title="文档大纲" visible={settings.showTableOfContents} onCancel={() => setOption('showTableOfContents', false)} footer={null} width={300} className="workspace-drawer"><WorkspaceOutline /></Drawer>
    </div>
  );
}

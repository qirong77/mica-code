import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {$getRoot} from 'lexical';
import {type ReactNode, useEffect, useState} from 'react';

import './notebook-workbench.css';
import './notebook-document.css';

import {useNotebookSession} from './NotebookBridge';
import NotebookBlockEditing from './NotebookBlockEditing';
import NotebookDocumentStyle from './NotebookDocumentStyle';
import NotebookPresentation from './NotebookPresentation';
import {countCharacters} from './storage';

export default function WorkspaceShell({children}: {children: ReactNode}) {
  const [editor] = useLexicalComposerContext();
  const session = useNotebookSession();
  const [characters, setCharacters] = useState(0);

  useEffect(() => {
    const updateCharacters = () => setCharacters(editor.getEditorState().read(() => countCharacters($getRoot().getTextContent())));
    updateCharacters();
    return editor.registerUpdateListener(({dirtyElements, dirtyLeaves}) => {
      if (!dirtyElements.size && !dirtyLeaves.size) return;
      updateCharacters();
      session?.dirty();
    });
  }, [editor, session]);

  return (
    <div className="workspace notebook-editor notebook-workbench">
      <section className="editor-canvas" aria-label="笔记富文本编辑器">
        {children}
        <NotebookBlockEditing />
        <NotebookDocumentStyle />
        <NotebookPresentation />
        <footer className="document-statusbar">
          <span role="status">{characters.toLocaleString()} 字</span>
        </footer>
      </section>
    </div>
  );
}

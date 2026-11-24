import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {type NodeKey, type UpdateListenerPayload} from 'lexical';
import {type ReactNode, useEffect, useRef, useState} from 'react';

import './notebook-workbench.css';
import './notebook-document.css';

import {useNotebookSession} from './NotebookBridge';
import NotebookBlockEditing from './NotebookBlockEditing';
import NotebookDocumentStyle from './NotebookDocumentStyle';
import {readNotebookCharacterCount, updateNotebookCharacterCount, type NotebookCharacterCountCache} from './storage';

export default function WorkspaceShell({children}: {children: ReactNode}) {
  const [editor] = useLexicalComposerContext();
  const session = useNotebookSession();
  const [characters, setCharacters] = useState(0);
  const characterCount = useRef<NotebookCharacterCountCache | null>(null);

  useEffect(() => {
    const initial = readNotebookCharacterCount(editor.getEditorState());
    characterCount.current = initial;
    setCharacters(initial.total);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: {editorState: UpdateListenerPayload['editorState']; dirtyElements: Map<NodeKey, boolean>; dirtyLeaves: Set<NodeKey>} | null = null;
    const updateCharacters = () => {
      timer = null;
      const update = pending;
      pending = null;
      if (!update || !characterCount.current) return;
      const next = updateNotebookCharacterCount(update.editorState, characterCount.current, update.dirtyElements, update.dirtyLeaves);
      setCharacters(previous => previous === next ? previous : next);
    };
    const scheduleCharacters = ({editorState, dirtyElements, dirtyLeaves}: UpdateListenerPayload) => {
      if (!dirtyElements.size && !dirtyLeaves.size) return;
      if (!pending) {
        pending = {editorState, dirtyElements: new Map(dirtyElements), dirtyLeaves: new Set(dirtyLeaves)};
      } else {
        pending.editorState = editorState;
        for (const [key, dirty] of dirtyElements) pending.dirtyElements.set(key, pending.dirtyElements.get(key) === true || dirty);
        for (const key of dirtyLeaves) pending.dirtyLeaves.add(key);
      }
      session?.dirty();
      if (timer === null) timer = setTimeout(updateCharacters, 100);
    };
    const unregister = editor.registerUpdateListener(scheduleCharacters);
    return () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
      characterCount.current = null;
      unregister();
    };
  }, [editor, session]);

  return (
    <div className="workspace notebook-editor notebook-workbench">
      <section className="editor-canvas" aria-label="笔记富文本编辑器">
        {children}
        <NotebookBlockEditing />
        <NotebookDocumentStyle />
        <footer className="document-statusbar">
          <span role="status">{characters.toLocaleString()} 字</span>
        </footer>
      </section>
    </div>
  );
}

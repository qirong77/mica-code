import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useEffect} from 'react';

import {registerNotebookBlockEditing} from './blockEditing';

export default function NotebookBlockEditing() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => registerNotebookBlockEditing(editor), [editor]);
  return null;
}

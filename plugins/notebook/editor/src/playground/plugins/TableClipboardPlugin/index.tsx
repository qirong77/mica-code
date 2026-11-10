import {Message} from '@arco-design/web-react';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useEffect} from 'react';

import {registerTableClipboard} from './tableClipboard';

export {parseTableClipboard} from './parseTableClipboard';
export {$appendTableRowOnTab, $pasteTableMatrix, registerTableClipboard} from './tableClipboard';

/** Mount beside Lexical's TablePlugin, inside the same LexicalComposer. */
export default function TableClipboardPlugin(): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => registerTableClipboard(editor, content => {
    Message.warning({content, duration: 5000});
  }), [editor]);
  return null;
}

import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useEffect} from 'react';
import {PLAYGROUND_TRANSFORMERS} from '../MarkdownTransformers';
import {registerMarkdownPaste} from './markdownPaste';

export default function MarkdownPastePlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => registerMarkdownPaste(editor, PLAYGROUND_TRANSFORMERS), [editor]);
  return null;
}

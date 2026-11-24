import {createHeadlessEditor} from '@lexical/headless';
import {$createParagraphNode, $createTextNode, $getNodeByKey, $getRoot, $isTextNode} from 'lexical';
import {describe, expect, it} from 'vitest';

import {readNotebookCharacterCount, updateNotebookCharacterCount} from '../src/workspace/storage';

describe('Notebook character count cache', () => {
  it('updates a leaf edit without walking the rest of the document and falls back on removal', () => {
    const editor = createHeadlessEditor({namespace: 'notebook-character-count', onError(error) {throw error;}});
    let textKey = '';
    let update: Parameters<Parameters<typeof editor.registerUpdateListener>[0]>[0] | null = null;
    const unregister = editor.registerUpdateListener(payload => { update = payload; });
    editor.update(() => {
      const text = $createTextNode('旧正文 😀');
      textKey = text.getKey();
      $getRoot().append($createParagraphNode().append(text));
    }, {discrete: true});
    const cache = readNotebookCharacterCount(editor.getEditorState());
    expect(cache.total).toBe(4);

    editor.update(() => {
      const node = $getNodeByKey(textKey);
      if ($isTextNode(node)) node.setTextContent('新正文 🧪');
    }, {discrete: true});
    expect(update).not.toBeNull();
    expect(updateNotebookCharacterCount(editor.getEditorState(), cache, update!.dirtyElements, update!.dirtyLeaves)).toBe(4);
    expect(cache.leaves.get(textKey)).toBe(4);

    editor.update(() => $getRoot().getFirstChild()?.remove(), {discrete: true});
    expect(update).not.toBeNull();
    expect(updateNotebookCharacterCount(editor.getEditorState(), cache, update!.dirtyElements, update!.dirtyLeaves)).toBe(0);
    unregister();
  });
});

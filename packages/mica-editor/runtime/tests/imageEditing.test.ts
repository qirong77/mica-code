// @vitest-environment happy-dom
import {buildEditorFromExtensions} from '@lexical/extension';
import {HeadlessExtension} from '@lexical/headless';
import {createEmptyHistoryState, registerHistory} from '@lexical/history';
import {$createLinkNode, $isLinkNode, LinkNode} from '@lexical/link';
import {
  $createParagraphNode, $createTextNode, $getNodeByKey, $getRoot, $getSelection,
  $isRangeSelection, $isElementNode, defineExtension, type LexicalEditor, UNDO_COMMAND,
} from 'lexical';
import {describe, expect, it} from 'vitest';

import {$createImageNode, $isImageNode, ImageNode} from '../src/playground/nodes/ImageNode';
import {$imageBlock, $removeImage, $selectImage, updateImage} from '../src/playground/nodes/imageEditing';

function makeEditor() {
  return buildEditorFromExtensions(defineExtension({name: '@test/image-edit', namespace: 'image-edit-test', dependencies: [HeadlessExtension], nodes: [ImageNode, LinkNode]}));
}

function fixture() {
  const editor = makeEditor();
  let key = '';
  editor.update(() => {
    $getRoot().clear();
    const image = $createImageNode({src: 'data:image/png;base64,original', altText: '原始描述', width: 640, height: 360, maxWidth: 900, showCaption: true});
    key = image.getKey();
    image.__caption.update(() => {$getRoot().append($createParagraphNode().append($createTextNode('保留图注')));}, {discrete: true});
    const link = $createLinkNode('https://example.com/', {target: '_blank', rel: 'noopener', title: '图片链接'}).append(image);
    $getRoot().append($createParagraphNode().append($createTextNode('前文 '), link, $createTextNode(' 后文')));
    $selectImage(image);
  }, {discrete: true});
  return {editor, key};
}

function imageJSON(editor: LexicalEditor) {
  const root = editor.getEditorState().toJSON().root;
  const paragraph = root.children[0] as unknown as {children: Array<{type: string; children?: Array<Record<string, unknown>>}>};
  return paragraph.children.find(child => child.type === 'link')!.children![0];
}

function flush(editor: LexicalEditor) {editor.update(() => {}, {discrete: true});}

describe('image edit transactions', () => {
  it('round-trips dimensions, description and alignment while preserving the link and hidden caption', () => {
    const {editor, key} = fixture();
    const before = imageJSON(editor);
    expect(updateImage(editor, key, node => {
      node.setWidthAndHeight(320, 180).setAltText('新的描述').setShowCaption(false);
      $imageBlock(node)?.setFormat('right');
    })).toBe(true);
    const state = editor.getEditorState().toJSON();
    expect(imageJSON(editor)).toMatchObject({width: 320, height: 180, altText: '新的描述', showCaption: false, caption: before.caption, src: before.src});
    const reopened = makeEditor();
    reopened.setEditorState(reopened.parseEditorState(JSON.stringify(state)));
    flush(reopened);
    expect(imageJSON(reopened)).toEqual(imageJSON(editor));
    reopened.read('latest', () => {
      const block = $getRoot().getFirstChild();
      if (!$isElementNode(block)) throw new Error('Expected image paragraph');
      expect(block.getTextContent()).toContain('前文');
      const link = block.getChildren().find($isLinkNode);
      expect(link && {url: link.getURL(), rel: link.getRel(), target: link.getTarget(), title: link.getTitle()}).toEqual({url: 'https://example.com/', rel: 'noopener', target: '_blank', title: '图片链接'});
      expect(block.getFormatType()).toBe('right');
    });
  });

  it('rejects stale source, detached target and read-only edits without touching the document', () => {
    const {editor, key} = fixture();
    const before = editor.getEditorState().toJSON();
    expect(updateImage(editor, key, node => node.setSrc('wrong'), 'different-src')).toBe(false);
    editor.setEditable(false);
    expect(updateImage(editor, key, node => node.setAltText('wrong'))).toBe(false);
    expect(editor.getEditorState().toJSON()).toEqual(before);
    editor.setEditable(true);
    expect(updateImage(editor, key, $removeImage)).toBe(true);
    const removed = editor.getEditorState().toJSON();
    expect(updateImage(editor, key, node => node.setSrc('late-result'))).toBe(false);
    expect(editor.getEditorState().toJSON()).toEqual(removed);
  });

  it('deletes only the target image and its empty link, retaining adjacent text and a valid caret', () => {
    const {editor, key} = fixture();
    expect(updateImage(editor, key, $removeImage)).toBe(true);
    editor.read('latest', () => {
      expect($getNodeByKey(key)).toBeNull();
      expect($getRoot().getTextContent()).toBe('前文  后文');
      expect($getRoot().getAllTextNodes().every(node => !$isLinkNode(node.getParent()))).toBe(true);
      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      if ($isRangeSelection(selection)) expect(selection.anchor.getNode().isAttached()).toBe(true);
    });
  });

  it('undo restores source and matching dimensions in one step and restores a deleted image with its caption', () => {
    const {editor, key} = fixture();
    const history = createEmptyHistoryState();
    history.current = {editor, editorState: editor.getEditorState()};
    const stop = registerHistory(editor, history, 300);
    const before = imageJSON(editor);
    expect(updateImage(editor, key, node => {node.setSrc('data:image/png;base64,rotated'); node.setWidthAndHeight(360, 640);})).toBe(true);
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    flush(editor);
    expect(imageJSON(editor)).toEqual(before);
    expect(updateImage(editor, key, $removeImage)).toBe(true);
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    flush(editor);
    expect(imageJSON(editor)).toEqual(before);
    editor.read('latest', () => expect($isImageNode($getNodeByKey(key))).toBe(true));
    stop();
  });
});

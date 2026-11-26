import {createHeadlessEditor} from '@lexical/headless';
import {createEmptyHistoryState, registerHistory} from '@lexical/history';
import {$createParagraphNode, $createTextNode, $getRoot, REDO_COMMAND, UNDO_COMMAND} from 'lexical';
import {describe, expect, it} from 'vitest';

import {$readDocumentStyle, $updateDocumentStyle, DEFAULT_DOCUMENT_STYLE, documentStyleVariables, parseDocumentStyle} from '../src/workspace/documentStyle';

const createEditor = () => createHeadlessEditor({
  namespace: 'document-workbench', nodes: [], onError(error) {throw error;},
});
const paragraph = (text: string) => $createParagraphNode().append($createTextNode(text));

describe('document appearance persistence', () => {
  it("uses Yuque's measured standard page geometry for new documents", () => {
    expect(documentStyleVariables(DEFAULT_DOCUMENT_STYLE)).toMatchObject({
      '--notebook-page-width': '850px',
      '--notebook-paragraph-gap': '0px',
      '--notebook-line-height': '1.74',
    });
  });

  it('reads defaults without rewriting existing documents', () => {
    const editor = createEditor();
    editor.update(() => {$getRoot().append(paragraph('正文'));}, {discrete: true});
    const before = editor.getEditorState();
    expect(before.read($readDocumentStyle)).toEqual(DEFAULT_DOCUMENT_STYLE);
    expect(editor.getEditorState()).toBe(before);
    expect(before.toJSON().root).not.toHaveProperty('$');
  });

  it('round-trips page width, spacing and font size without erasing explicit text formatting', () => {
    const editor = createEditor();
    editor.update(() => {
      $getRoot().append($createParagraphNode().append($createTextNode('自定义正文').setStyle('font-size: 24px; color: red;').toggleFormat('bold')));
      $updateDocumentStyle({bodySize: 18, pageSize: 'wide', paragraphSpacing: 'normal', lineHeight: 2});
    }, {discrete: true});
    const reopened = createEditor();
    reopened.setEditorState(reopened.parseEditorState(JSON.stringify(editor.getEditorState().toJSON())));
    reopened.getEditorState().read(() => {
      expect($readDocumentStyle()).toEqual({bodySize: 18, pageSize: 'wide', paragraphSpacing: 'normal', lineHeight: 2});
      const text = $getRoot().getAllTextNodes()[0];
      expect(text.getStyle()).toBe('font-size: 24px; color: red;');
      expect(text.hasFormat('bold')).toBe(true);
    });
  });

  it('undoes and redoes document appearance with the normal history', async () => {
    const editor = createEditor();
    editor.update(() => {$getRoot().append(paragraph('正文'));}, {discrete: true});
    const history = createEmptyHistoryState();
    history.current = {editor, editorState: editor.getEditorState()};
    const unregister = registerHistory(editor, history, 0);
    editor.update(() => {$updateDocumentStyle({bodySize: 20});}, {discrete: true, tag: 'history-push'});
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    await Promise.resolve();
    expect(editor.getEditorState().read($readDocumentStyle).bodySize).toBe(15);
    editor.dispatchCommand(REDO_COMMAND, undefined);
    await Promise.resolve();
    expect(editor.getEditorState().read($readDocumentStyle).bodySize).toBe(20);
    unregister();
  });

  it('bounds invalid document metadata to usable defaults', () => {
    expect(parseDocumentStyle({bodySize: -1, pageSize: 'invalid', lineHeight: Infinity, paragraphSpacing: null})).toEqual(DEFAULT_DOCUMENT_STYLE);
  });
});

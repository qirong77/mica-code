import {createHeadlessEditor} from '@lexical/headless';
import {createEmptyHistoryState, registerHistory} from '@lexical/history';
import {$createHeadingNode, HeadingNode} from '@lexical/rich-text';
import {$createParagraphNode, $createTextNode, $getRoot, REDO_COMMAND, UNDO_COMMAND} from 'lexical';
import {describe, expect, it} from 'vitest';

import {$createPageBreakNode, PageBreakNode} from '../src/playground/nodes/PageBreakNode';
import {$readDocumentStyle, $updateDocumentStyle, DEFAULT_DOCUMENT_STYLE, parseDocumentStyle} from '../src/workspace/documentStyle';
import {$readNotebookSlides} from '../src/workspace/presentation';

const createEditor = () => createHeadlessEditor({
  namespace: 'document-workbench', nodes: [HeadingNode, PageBreakNode], onError(error) {throw error;},
});
const paragraph = (text: string) => $createParagraphNode().append($createTextNode(text));

describe('document appearance persistence', () => {
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

describe('presentation pagination', () => {
  it('keeps lower headings with their section and includes an introduction', () => {
    const editor = createEditor();
    editor.update(() => {
      $getRoot().append(paragraph('引言'), $createHeadingNode('h1').append($createTextNode('章节')), paragraph('概览'),
        $createHeadingNode('h2').append($createTextNode('主题')), $createHeadingNode('h3').append($createTextNode('细节')), paragraph('内容'));
    }, {discrete: true});
    const before = editor.getEditorState();
    const slides = before.read($readNotebookSlides);
    expect(slides.map(slide => [slide.title, slide.keys.length])).toEqual([['开始', 1], ['章节', 2], ['主题', 3]]);
    expect(editor.getEditorState()).toBe(before);
  });

  it('uses the available heading level when a document only has small headings', () => {
    const editor = createEditor();
    editor.update(() => {$getRoot().append($createHeadingNode('h3').append($createTextNode('A')), paragraph('正文'), $createHeadingNode('h3').append($createTextNode('B')));}, {discrete: true});
    expect(editor.getEditorState().read($readNotebookSlides).map(slide => slide.title)).toEqual(['A', 'B']);
  });

  it('honors page breaks without generating empty slides', () => {
    const editor = createEditor();
    editor.update(() => {$getRoot().append($createPageBreakNode(), paragraph('第一页'), $createPageBreakNode(), $createPageBreakNode(), paragraph('第二页'), $createPageBreakNode());}, {discrete: true});
    const slides = editor.getEditorState().read($readNotebookSlides);
    expect(slides.map(slide => slide.keys.length)).toEqual([1, 1]);
  });

  it('does not create an extra introduction for empty leading paragraphs', () => {
    const editor = createEditor();
    editor.update(() => {$getRoot().append($createParagraphNode(), $createHeadingNode('h1').append($createTextNode('正文标题')));}, {discrete: true});
    expect(editor.getEditorState().read($readNotebookSlides).map(slide => slide.title)).toEqual(['正文标题']);
  });

  it('still presents an empty document as one page', () => {
    const editor = createEditor();
    editor.update(() => {$getRoot().append($createParagraphNode());}, {discrete: true});
    expect(editor.getEditorState().read($readNotebookSlides)).toEqual([{title: '空白文档', keys: [editor.getEditorState().read(() => $getRoot().getFirstChild()!.getKey())]}]);
  });
});

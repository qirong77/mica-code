import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {HeadlessExtension} from '@lexical/headless';
import {$createHeadingNode, HeadingNode, RichTextExtension} from '@lexical/rich-text';
import {$createParagraphNode, $createTextNode, $getRoot, type LexicalEditor} from 'lexical';
import {afterEach, describe, expect, it} from 'vitest';

import {$ensureNotebookTitle, $readNotebookTitle, normalizeNotebookTitle} from '../src/workspace/notebookTitle';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function makeEditor(): LexicalEditor {
  const editor = buildEditorFromExtensions(defineExtension({
    name: '@test/notebook-title',
    namespace: 'notebook-title',
    dependencies: [HeadlessExtension, RichTextExtension],
    nodes: [HeadingNode],
    onError(error) { throw error; },
  }));
  cleanups.push(() => editor[Symbol.dispose]());
  return editor;
}

function title(editor: LexicalEditor) {
  return editor.getEditorState().read($readNotebookTitle);
}

/** 和 NotebookSession.ensureTitle 一样：结构缺失就补，文字只在显式改名时写入。 */
function ensure(editor: LexicalEditor, alignTo: string | null) {
  return editor.update(() => $ensureNotebookTitle(alignTo), {discrete: true});
}

describe('notebook title block', () => {
  it('keeps a title the user cleared completely empty', () => {
    const editor = makeEditor();
    editor.update(() => {
      $getRoot().clear().append($createHeadingNode('h1')).append($createParagraphNode());
    }, {discrete: true});
    const headingKey = editor.getEditorState().read(() => $readNotebookTitle().key);

    ensure(editor, null);
    expect(title(editor)).toMatchObject({key: headingKey, text: '', firstIsTitle: true});

    // 每次键入后都会再跑一遍，空标题不能被旧名字填回去。
    ensure(editor, null);
    ensure(editor, null);
    expect(title(editor).text).toBe('');
  });

  it('fills the title only when the host explicitly renames the note', () => {
    const editor = makeEditor();
    editor.update(() => {
      $getRoot().clear().append($createHeadingNode('h1'));
    }, {discrete: true});

    ensure(editor, '会议记录');
    expect(title(editor).text).toBe('会议记录');

    // 同一个名字再对齐一次不产生无谓的更新（不会重排文字节点与光标）。
    expect(editor.update(() => $ensureNotebookTitle('会议记录'), {discrete: true})).toBeUndefined();
    expect(title(editor).text).toBe('会议记录');
  });

  it('creates the missing title block without inventing text', () => {
    const editor = makeEditor();
    editor.update(() => {
      $getRoot().clear().append($createParagraphNode());
    }, {discrete: true});

    ensure(editor, null);
    expect(title(editor)).toMatchObject({text: '', firstIsTitle: true});
  });

  it('creates a titled block for a document that has no H1 yet', () => {
    const editor = makeEditor();
    editor.update(() => {
      $getRoot().clear().append($createParagraphNode());
    }, {discrete: true});

    ensure(editor, normalizeNotebookTitle(undefined));
    expect(title(editor).text).toBe('未命名笔记');
  });

  it('never leaves the H1 below another top-level block', () => {
    const editor = makeEditor();
    editor.update(() => {
      $getRoot().clear().append($createParagraphNode()).append($createHeadingNode('h1').append($createTextNode('正文标题')));
    }, {discrete: true});

    ensure(editor, null);
    const first = editor.getEditorState().read(() => $readNotebookTitle());
    expect(first.firstIsTitle).toBe(true);
    expect(first.text).toBe('');
  });
});

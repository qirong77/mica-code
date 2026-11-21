import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {HeadlessExtension} from '@lexical/headless';
import {$createHeadingNode, HeadingNode, RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setSelection,
  FORMAT_TEXT_COMMAND,
  type LexicalEditor,
  PASTE_COMMAND,
} from 'lexical';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  $ensureNotebookTitle,
  $getNotebookTitleNode,
  $insertNotebookTitleText,
  $isNotebookTitleSelection,
  $readNotebookTitle,
  normalizeNotebookTitle,
  normalizeNotebookTitlePaste,
  registerNotebookTitle,
  type NotebookTitleState,
} from '../src/workspace/notebookTitle';

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

/** Reads with pending updates flushed: a dispatched command commits on flush. */
function readLatest<T>(editor: LexicalEditor, read: () => T): T {
  let value = {} as T;
  editor.read('latest', () => { value = read(); });
  return value;
}

function title(editor: LexicalEditor): NotebookTitleState {
  return readLatest(editor, $readNotebookTitle);
}

/** 和 NotebookSession.ensureTitle 一样：结构缺失就补，文字只在显式改名时写入。 */
function ensure(editor: LexicalEditor, alignTo: string | null) {
  return editor.update(() => $ensureNotebookTitle(alignTo), {discrete: true});
}

function register(editor: LexicalEditor) {
  cleanups.push(registerNotebookTitle(editor));
}

function seed(editor: LexicalEditor) {
  editor.update(() => {
    $getRoot().clear()
      .append($createHeadingNode('h1').append($createTextNode('Go包管理')))
      .append($createParagraphNode().append($createTextNode('正文')));
  }, {discrete: true});
}

function clipboardEvent(text: string) {
  const preventDefault = vi.fn();
  const getData = vi.fn((type: string) => (type === 'text/plain' ? text : ''));
  const event = {
    preventDefault,
    clipboardData: {getData},
  } as unknown as ClipboardEvent;
  return {event, preventDefault, getData};
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

describe('notebook title is plain text only', () => {
  it('strips a legacy rich title on load and keeps its visible characters', () => {
    const editor = makeEditor();
    editor.update(() => {
      const heading = $createHeadingNode('h1').setFormat('center').setIndent(1);
      heading.append($createTextNode('Go包管理与工程结构').setFormat('code').setStyle('font-size: 20px; color: red'));
      heading.append($createTextNode('（go.mod与package）').setFormat('bold'));
      $getRoot().clear().append(heading).append($createParagraphNode());
    }, {discrete: true});
    expect(title(editor).plain).toBe(false);

    ensure(editor, null);

    const state = title(editor);
    expect(state.text).toBe('Go包管理与工程结构（go.mod与package）');
    expect(state.plain).toBe(true);
    editor.read('latest', () => {
      const node = $getNotebookTitleNode();
      // Element formatting is bit flags at runtime ('' maps to 0).
      expect(node?.getFormat() as unknown).toBe(0);
      expect(node?.getIndent()).toBe(0);
      expect(node?.getChildren().every(child => $isTextNode(child) && child.getFormat() === 0)).toBe(true);
    });
    // 清过一次之后再跑一遍也是干净的（transform 不会反复触发）。
    ensure(editor, null);
    expect(title(editor)).toMatchObject({text: 'Go包管理与工程结构（go.mod与package）', plain: true});
  });

  it('normalizes formatting that reaches the title in the same update', () => {
    const editor = makeEditor();
    register(editor);
    seed(editor);

    editor.update(() => {
      const text = $getNotebookTitleNode()?.getFirstChild();
      if ($isTextNode(text)) text.setFormat('code').setStyle('color: red');
    }, {discrete: true});

    expect(title(editor)).toMatchObject({text: 'Go包管理', plain: true});
  });

  it('ignores rich-text commands while the selection is inside the title', () => {
    const editor = makeEditor();
    register(editor);
    seed(editor);
    editor.update(() => {
      const node = $getNotebookTitleNode();
      node?.select(0, node.getTextContent().length);
    }, {discrete: true});

    expect(readLatest(editor, $isNotebookTitleSelection)).toBe(true);
    expect(editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')).toBe(true);
    expect(title(editor)).toMatchObject({text: 'Go包管理', plain: true});

    // 正文里的选区不算标题选区：拦截只发生在标题里。
    editor.update(() => {
      const paragraph = $getRoot().getLastChildOrThrow();
      if ($isElementNode(paragraph)) paragraph.select(0, 1);
    }, {discrete: true});
    expect(readLatest(editor, $isNotebookTitleSelection)).toBe(false);
  });

  it('intercepts a paste in the title so no Markdown prompt or code block runs', () => {
    const editor = makeEditor();
    register(editor);
    seed(editor);
    editor.update(() => {
      const text = $getNotebookTitleNode()?.getFirstChild();
      if ($isTextNode(text)) text.select(text.getTextContentSize(), text.getTextContentSize());
    }, {discrete: true});

    const {event, preventDefault, getData} = clipboardEvent('（go.mod与package）\n\n```go\npackage main\n```');
    expect(readLatest(editor, $isNotebookTitleSelection)).toBe(true);
    // 标题里的粘贴由这里消费：插件看不到这次粘贴，也就没有 Markdown 提示。
    expect(editor.dispatchCommand(PASTE_COMMAND, event)).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(getData).toHaveBeenCalledWith('text/plain');

    // 没有代码块、正文没有被动过。
    readLatest(editor, () => {
      expect($getRoot().getChildrenSize()).toBe(2);
      expect($getRoot().getFirstChildOrThrow().getType()).toBe('heading');
    });
  });

  it('lands pasted text in the title as plain characters', () => {
    const editor = makeEditor();
    register(editor);
    seed(editor);
    editor.update(() => {
      const text = $getNotebookTitleNode()?.getFirstChild();
      if ($isTextNode(text)) text.select(text.getTextContentSize(), text.getTextContentSize());
    }, {discrete: true});

    editor.update(() => {
      expect($insertNotebookTitleText('（go.mod与package）\n\n```go\npackage main\n```')).toBe(true);
    }, {discrete: true});

    expect(title(editor)).toMatchObject({
      text: 'Go包管理（go.mod与package） ```go package main ```',
      plain: true,
    });
    readLatest(editor, () => {
      expect($getRoot().getChildrenSize()).toBe(2);
      expect($getRoot().getFirstChildOrThrow().getType()).toBe('heading');
    });
  });

  it('leaves a range that reaches into the body alone', () => {
    const editor = makeEditor();
    register(editor);
    seed(editor);
    editor.update(() => {
      const heading = $getNotebookTitleNode();
      const paragraph = $getRoot().getLastChildOrThrow();
      if (!heading || !$isElementNode(paragraph)) return;
      const titleText = heading.getFirstChild();
      const bodyText = paragraph.getFirstChild();
      if (!$isTextNode(titleText) || !$isTextNode(bodyText)) return;
      const selection = $createRangeSelection();
      selection.anchor.set(titleText.getKey(), 1, 'text');
      selection.focus.set(bodyText.getKey(), 1, 'text');
      $setSelection(selection);
    }, {discrete: true});
    expect(readLatest(editor, $isNotebookTitleSelection)).toBe(false);

    // 跨标题/正文的 range 不拦截命令；即使命令落到标题上，它也还是普通文本。
    expect(editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')).toBe(true);
    expect(title(editor)).toMatchObject({text: 'Go包管理', plain: true});
  });

  it('collapses newlines and padding in pasted text', () => {
    expect(normalizeNotebookTitlePaste('  一行\n\n 二行\t三行  ')).toBe('一行 二行 三行');
    expect(normalizeNotebookTitlePaste('\n\n')).toBe('');
  });
});

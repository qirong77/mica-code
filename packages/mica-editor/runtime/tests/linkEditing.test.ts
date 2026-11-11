import {namedSignals} from '@lexical/extension';
import {createHeadlessEditor} from '@lexical/headless';
import {
  $createAutoLinkNode,
  $createLinkNode,
  $isAutoLinkNode,
  $isLinkNode,
  AutoLinkNode,
  autoLinkUrlMatcher,
  LinkNode,
  registerAutoLink,
  registerLink,
  TOGGLE_LINK_COMMAND,
} from '@lexical/link';
import {
  $applyNodeReplacement,
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  DecoratorNode,
  type LexicalEditor,
  type NodeKey,
} from 'lexical';
import {describe, expect, it} from 'vitest';

import {
  $applyLinkEdit,
  $createLinkEditSession,
  $getSelectedLinkNode,
  $removeLink,
  $restoreLinkSelection,
  type LinkEditSession,
  normalizeLinkUrl,
  registerLinkDraftRequests,
} from '../src/playground/plugins/FloatingLinkEditorPlugin/linkEditing';
import {validateUrl} from '../src/playground/utils/url';

// A real inline decorator exercises Lexical's image-style NodeSelection without
// rendering the image component or its nested React caption editor in Node.
class InlineImage extends DecoratorNode<null> {
  static getType() {
    return 'test-inline-image';
  }
  static clone(node: InlineImage) {
    return new InlineImage(node.__key);
  }
  constructor(key: NodeKey | undefined = undefined) {
    super(key);
  }
  isInline() {
    return true;
  }
  decorate() {
    return null;
  }
}

function makeEditor(parentEditor?: LexicalEditor) {
  const editor = createHeadlessEditor({
    namespace: 'link-editing-test',
    parentEditor,
    nodes: [LinkNode, AutoLinkNode, InlineImage],
    onError(error) {
      throw error;
    },
  });
  registerLink(editor, namedSignals({validateUrl, attributes: undefined}));
  return editor;
}

function update(editor: LexicalEditor, operation: () => void) {
  editor.update(operation, {discrete: true});
}

function capture(editor: LexicalEditor) {
  const session = editor.read('latest', () => $createLinkEditSession(editor));
  if (!session) throw new Error('Expected an editable link selection');
  return session;
}

function $text(key: string) {
  const node = $getNodeByKey(key);
  if (!$isTextNode(node)) throw new Error(`Missing text ${key}`);
  return node;
}

function $link(key: string) {
  const node = $getNodeByKey(key);
  if (!$isLinkNode(node)) throw new Error(`Missing link ${key}`);
  return node;
}

function linkedText() {
  const editor = makeEditor();
  let linkKey = '',
    textKey = '',
    beforeKey = '';
  update(editor, () => {
    const before = $createTextNode('前文 ');
    const first = $createTextNode('链接').toggleFormat('bold');
    const second = $createTextNode('文字').toggleFormat('italic');
    const link = $createLinkNode('https://old.example/path', {
      rel: 'noopener noreferrer',
      target: '_blank',
      title: '保留标题',
    }).append(first, second);
    beforeKey = before.getKey();
    linkKey = link.getKey();
    textKey = second.getKey();
    $getRoot().append($createParagraphNode().append(before, link, $createTextNode(' 后文')));
    second.select(2, 0);
  });
  return {editor, linkKey, textKey, beforeKey};
}

function apply(session: LinkEditSession, value: string) {
  let result: ReturnType<typeof $applyLinkEdit> | undefined;
  update(session.editor, () => {
    result = $applyLinkEdit(session, value);
  });
  return result!;
}

function assertSelection(editor: LexicalEditor, session: LinkEditSession) {
  editor.read('latest', () => expect($getSelection()?.is(session.selection)).toBe(true));
}

const invalidAddresses = [
  '',
  '  ',
  'https://',
  'http://',
  'https:///example.com',
  'https://?q=foo',
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'java\nscript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'file:///etc/passwd',
  'about:blank',
  'ftp://example.com',
  'sms:+123',
  'https://example.com\nother',
  'https://example.com/a b',
  'https://example.com/\u0000',
  'www.',
  'hello',
  'https://.example.com',
  'https://foo..com',
  'mailto:',
  'mailto:incomplete',
  'mailto://name@example.com',
  'mailto:name@example.com?subject=x%0Aevil',
  'tel:',
  'tel:no-number',
];

describe('link dialog URL validation', () => {
  it.each([
    ['example.com', 'https://example.com/'],
    ['  example.com/docs?q=1#intro  ', 'https://example.com/docs?q=1#intro'],
    ['www.example.com', 'https://www.example.com/'],
    ['example.com:8443/docs', 'https://example.com:8443/docs'],
    ['localhost:3000', 'https://localhost:3000/'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080/'],
    ['https://例子.测试/文档', 'https://xn--fsqu00a.xn--0zwm56d/%E6%96%87%E6%A1%A3'],
    ['mailto:name@example.com?subject=hello', 'mailto:name@example.com?subject=hello'],
    ['tel:+8613800138000', 'tel:+8613800138000'],
    ['tel:+1-555-0100;ext=42', 'tel:+1-555-0100;ext=42'],
  ])('normalizes %s to a usable address', (input, url) => {
    expect(normalizeLinkUrl(input)).toEqual({ok: true, url});
  });

  it.each(invalidAddresses)('rejects %j without changing content or selection', (value) => {
    const {editor} = linkedText();
    const session = capture(editor);
    const document = editor.getEditorState().toJSON();
    const result = apply(session, value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
    expect(editor.getEditorState().toJSON()).toEqual(document);
    assertSelection(editor, session);
  });
});

describe('link drafts and selection', () => {
  it('intercepts the existing toolbar insertion without writing a placeholder; cancelling restores the selected text', () => {
    const editor = makeEditor();
    update(editor, () => {
      const text = $createTextNode('选择这些文字').toggleFormat('bold');
      $getRoot().append($createParagraphNode().append(text));
      text.select(2, 4);
    });
    const before = editor.getEditorState().toJSON();
    let requested: LinkEditSession | undefined;
    const unregister = registerLinkDraftRequests(editor, (session) => {
      requested = session;
    });
    update(editor, () => {
      expect(editor.dispatchCommand(TOGGLE_LINK_COMMAND, 'https://')).toBe(true);
    });
    expect(requested).toBeDefined();
    expect(editor.getEditorState().toJSON()).toEqual(before);
    update(editor, () => $setSelection(null));
    update(editor, () => expect($restoreLinkSelection(requested!)).toBe(true));
    expect(editor.getEditorState().toJSON()).toEqual(before);
    assertSelection(editor, requested!);
    editor.read('latest', () => expect($getSelection()?.getTextContent()).toBe('这些'));
    unregister();
  });

  it('applies a new link only to the original selected text after input focus has moved the selection', () => {
    const editor = makeEditor();
    let otherKey = '';
    update(editor, () => {
      const text = $createTextNode('选择这些文字').toggleFormat('bold');
      const other = $createParagraphNode().append($createTextNode('别的段落'));
      $getRoot().append($createParagraphNode().append(text), other);
      otherKey = other.getKey();
      text.select(2, 4);
    });
    const session = capture(editor);
    update(editor, () => {
      const other = $getNodeByKey(otherKey);
      if ($isElementNode(other)) other.selectEnd();
    });
    expect(apply(session, 'example.com/docs')).toEqual({ok: true, url: 'https://example.com/docs'});
    editor.read('latest', () => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      if (!$isElementNode(paragraph)) throw new Error('Expected paragraph');
      expect(paragraph.getChildren().map((node) => [node.getType(), node.getTextContent()])).toEqual([
        ['text', '选择'],
        ['link', '这些'],
        ['text', '文字'],
      ]);
      const link = paragraph.getChildAtIndex(1);
      expect($isLinkNode(link) && link.getURL()).toBe('https://example.com/docs');
      expect($isLinkNode(link) && link.getAllTextNodes()[0].hasFormat('bold')).toBe(true);
      expect($getSelection()?.getTextContent()).toBe('这些');
      expect($getRoot().getLastChildOrThrow().getTextContent()).toBe('别的段落');
    });
  });

  it('updates an entire existing link while retaining its formatting, attributes and backwards selection', () => {
    const {editor, linkKey, textKey} = linkedText();
    const session = capture(editor);
    update(editor, () => $setSelection(null));
    expect(apply(session, 'example.com/updated').ok).toBe(true);
    assertSelection(editor, session);
    editor.read('latest', () => {
      const link = $link(linkKey);
      expect(link.getURL()).toBe('https://example.com/updated');
      expect(link.getTextContent()).toBe('链接文字');
      expect(link.getAllTextNodes().map((node) => [node.hasFormat('bold'), node.hasFormat('italic')])).toEqual([
        [true, false],
        [false, true],
      ]);
      expect([link.getRel(), link.getTarget(), link.getTitle()]).toEqual(['noopener noreferrer', '_blank', '保留标题']);
      expect($text(textKey).getParent()?.getKey()).toBe(linkKey);
      expect($getSelection()?.isBackward()).toBe(true);
      expect($getRoot().getTextContent()).toBe('前文 链接文字 后文');
    });
  });

  it('cancels an existing-link edit without reverting intervening document changes', () => {
    const {editor, linkKey} = linkedText();
    const session = capture(editor);
    update(editor, () => {
      $getRoot().append($createParagraphNode().append($createTextNode('编辑期间到达的内容')));
      $setSelection(null);
    });
    const beforeCancel = editor.getEditorState().toJSON();
    update(editor, () => expect($restoreLinkSelection(session)).toBe(true));
    expect(editor.getEditorState().toJSON()).toEqual(beforeCancel);
    editor.read('latest', () => expect($link(linkKey).getURL()).toBe('https://old.example/path'));
    assertSelection(editor, session);
  });

  it('removes an entire link while preserving its formatted text and backwards selection', () => {
    const {editor, textKey} = linkedText();
    const session = capture(editor);
    update(editor, () => $setSelection(null));
    update(editor, () => expect($removeLink(session)).toBe(true));
    assertSelection(editor, session);
    editor.read('latest', () => {
      expect($getRoot().getTextContent()).toBe('前文 链接文字 后文');
      expect($text(textKey).hasFormat('italic')).toBe(true);
      expect($text(textKey).getParent()?.getType()).toBe('paragraph');
      expect($getSelection()?.getTextContent()).toBe('文字');
      expect(
        $getRoot()
          .getAllTextNodes()
          .some((node) => $isLinkNode(node.getParent())),
      ).toBe(false);
    });
  });

  it('inserts a link at a plain-text caret without replacing surrounding text', () => {
    const editor = makeEditor();
    update(editor, () => {
      const text = $createTextNode('前后');
      $getRoot().append($createParagraphNode().append(text));
      text.select(1, 1);
    });
    expect(apply(capture(editor), 'example.com').ok).toBe(true);
    editor.read('latest', () => expect($getRoot().getTextContent()).toBe('前https://example.com/后'));
  });

  it('edits and removes a single-character link at a right-biased caret boundary', () => {
    const editor = makeEditor();
    let linkKey = '',
      beforeKey = '';
    update(editor, () => {
      const before = $createTextNode('前');
      const link = $createLinkNode('https://old.example').append($createTextNode('链'));
      beforeKey = before.getKey();
      linkKey = link.getKey();
      $getRoot().append($createParagraphNode().append(before, link, $createTextNode('后')));
      before.selectEnd();
    });
    const session = capture(editor);
    expect(session.linkKey).toBe(linkKey);
    expect(apply(session, 'example.com').ok).toBe(true);
    assertSelection(editor, session);
    editor.read('latest', () => {
      expect($link(linkKey).getTextContent()).toBe('链');
      expect($text(beforeKey).getParent()?.getType()).toBe('paragraph');
    });
    update(editor, () => expect($removeLink(session)).toBe(true));
    editor.read('latest', () => {
      expect($getRoot().getTextContent()).toBe('前链后');
      expect(
        $getRoot()
          .getAllTextNodes()
          .every((node) => !$isLinkNode(node.getParent())),
      ).toBe(true);
    });
  });

  it('does not mistake a range crossing plain text for editing only its focused link', () => {
    const {editor, beforeKey, textKey} = linkedText();
    update(editor, () => {
      const selection = $text(beforeKey).select(1, 1);
      selection.focus.set(textKey, 1, 'text');
      expect($getSelectedLinkNode(selection)).toBeNull();
    });
  });

  it('refuses a stale target instead of editing the current unrelated selection', () => {
    const {editor, linkKey, beforeKey} = linkedText();
    const session = capture(editor);
    update(editor, () => {
      $link(linkKey).remove();
      $text(beforeKey).selectEnd();
    });
    const before = editor.getEditorState().toJSON();
    expect(apply(session, 'example.com').ok).toBe(false);
    expect(editor.getEditorState().toJSON()).toEqual(before);
  });

  it('keeps nested-editor requests and edits scoped to their owning editor', () => {
    const parent = linkedText();
    const nested = makeEditor(parent.editor);
    let nestedKey = '';
    update(nested, () => {
      const text = $createTextNode('图片说明链接');
      const link = $createLinkNode('https://caption.example').append(text);
      nestedKey = link.getKey();
      $getRoot().append($createParagraphNode().append(link));
      text.select(0, 2);
    });
    let requested: LinkEditSession | undefined;
    registerLinkDraftRequests(parent.editor, (session) => {
      requested = session;
    });
    update(nested, () => nested.dispatchCommand(TOGGLE_LINK_COMMAND, 'https://'));
    expect(requested?.editor).toBe(nested);
    const beforeParent = parent.editor.getEditorState().toJSON();
    update(parent.editor, () => expect($applyLinkEdit(requested!, 'example.com').ok).toBe(false));
    expect(apply(requested!, 'example.com/caption').ok).toBe(true);
    expect(parent.editor.getEditorState().toJSON()).toEqual(beforeParent);
    nested.read('latest', () => expect($link(nestedKey).getURL()).toBe('https://example.com/caption'));
    assertSelection(nested, requested!);
  });

  it('does not save after the owning editor becomes read-only', () => {
    const {editor} = linkedText();
    const session = capture(editor);
    const before = editor.getEditorState().toJSON();
    editor.setEditable(false);
    expect(apply(session, 'example.com').ok).toBe(false);
    expect(editor.getEditorState().toJSON()).toEqual(before);
  });
});

describe('automatic links and linked images', () => {
  function autoLinkedText() {
    const editor = makeEditor();
    registerAutoLink(editor, {matchers: [autoLinkUrlMatcher], changeHandlers: [], excludeParents: []});
    let textKey = '';
    update(editor, () => {
      const text = $createTextNode('https://example.com');
      $getRoot().append($createParagraphNode().append(text));
      text.select(1, 4);
    });
    editor.read('latest', () => {
      textKey = $getRoot().getAllTextNodes()[0].getKey();
    });
    return {editor, textKey};
  }

  it('converts an edited automatic link to manual and keeps the saved URL through later transforms', () => {
    const {editor, textKey} = autoLinkedText();
    const session = capture(editor);
    editor.read('latest', () => expect($isAutoLinkNode($getNodeByKey(session.linkKey!))).toBe(true));
    update(editor, () => $setSelection(null));
    expect(apply(session, 'example.com/manual').ok).toBe(true);
    assertSelection(editor, session);
    update(editor, () => $text(textKey).setTextContent('https://changed.example'));
    editor.read('latest', () => {
      const parent = $text(textKey).getParent();
      expect($isLinkNode(parent)).toBe(true);
      expect($isAutoLinkNode(parent)).toBe(false);
      expect($isLinkNode(parent) && parent.getURL()).toBe('https://example.com/manual');
    });
  });

  it('removes automatic linking without letting the next transform recreate it', () => {
    const {editor, textKey} = autoLinkedText();
    const session = capture(editor);
    update(editor, () => expect($removeLink(session)).toBe(true));
    update(editor, () => $text(textKey).markDirty());
    assertSelection(editor, session);
    editor.read('latest', () => {
      const parent = $text(textKey).getParent();
      expect($isAutoLinkNode(parent) && parent.getIsUnlinked()).toBe(true);
      expect($getSelectedLinkNode($getSelection())).toBeNull();
      expect($getRoot().getTextContent()).toBe('https://example.com');
    });
  });

  it.each([false, true])(
    'updates and removes a node-selected linked image (automatic=%s) without deleting the image',
    (automatic) => {
      const editor = makeEditor();
      let imageKey = '';
      update(editor, () => {
        const image = $applyNodeReplacement(new InlineImage());
        imageKey = image.getKey();
        const link = automatic ? $createAutoLinkNode('https://old.example') : $createLinkNode('https://old.example');
        $getRoot().append($createParagraphNode().append(link.append(image)));
        const selection = $createNodeSelection();
        selection.add(imageKey);
        $setSelection(selection);
      });
      const session = capture(editor);
      update(editor, () => $setSelection(null));
      expect(apply(session, 'example.com/image').ok).toBe(true);
      assertSelection(editor, session);
      editor.read('latest', () => {
        const parent = $getNodeByKey(imageKey)?.getParent();
        expect($isLinkNode(parent) && parent.getURL()).toBe('https://example.com/image');
      });
      const updatedSession = capture(editor);
      update(editor, () => expect($removeLink(updatedSession)).toBe(true));
      editor.read('latest', () => {
        expect($getNodeByKey(imageKey)?.isAttached()).toBe(true);
        expect($getNodeByKey(imageKey)?.getParent()?.getType()).toBe('paragraph');
        const selection = $getSelection();
        expect($isNodeSelection(selection) && selection.has(imageKey)).toBe(true);
      });
    },
  );

  it('retains node selection when an automatic link itself is selected', () => {
    const editor = makeEditor();
    update(editor, () => {
      const link = $createAutoLinkNode('https://old.example').append($createTextNode('链接'));
      $getRoot().append($createParagraphNode().append(link));
      const selection = $createNodeSelection();
      selection.add(link.getKey());
      $setSelection(selection);
    });
    expect(apply(capture(editor), 'example.com').ok).toBe(true);
    editor.read('latest', () => {
      const nodes = $getSelection()?.getNodes();
      expect(nodes).toHaveLength(1);
      expect(nodes?.[0].getType()).toBe('link');
      expect(nodes?.[0].isAttached()).toBe(true);
    });
    const session = capture(editor);
    update(editor, () => expect($removeLink(session)).toBe(true));
    editor.read('latest', () => {
      const nodes = $getSelection()?.getNodes();
      expect(nodes?.map((node) => [node.getType(), node.getTextContent()])).toEqual([['text', '链接']]);
    });
  });

  it('preserves a range directly on an automatic link element when converting it', () => {
    const editor = makeEditor();
    update(editor, () => {
      const link = $createAutoLinkNode('https://old.example').append($createTextNode('x'));
      $getRoot().append($createParagraphNode().append(link));
      link.select(0, 1);
    });
    expect(apply(capture(editor), 'example.com').ok).toBe(true);
    editor.read('latest', () => {
      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      expect(selection?.getTextContent()).toBe('x');
      if ($isRangeSelection(selection)) {
        expect(selection.anchor.getNode().isAttached()).toBe(true);
        expect(selection.focus.getNode().isAttached()).toBe(true);
      }
    });
  });
});

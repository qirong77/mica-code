import {
  $createLinkNode,
  $isAutoLinkNode,
  $isLinkNode,
  $toggleLink,
  type LinkNode,
  TOGGLE_LINK_COMMAND,
} from '@lexical/link';
import {
  $createTextNode,
  $findMatchingParent,
  $getEditor,
  $getNodeByKey,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isNodeSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  type BaseSelection,
  COMMAND_PRIORITY_HIGH,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type NodeSelection,
  type RangeSelection,
} from 'lexical';

import {getSelectedNode} from '../../utils/getSelectedNode';
import {sanitizeUrl} from '../../utils/url';

type LinkResult = {ok: true; url: string} | {ok: false; error: string};

const INVALID_ADDRESS = '请输入完整的网址，例如 https://example.com。';
const STALE_SELECTION = '原来的选区已变化，请重新选择文字或链接。';

/** These stricter rules belong to the link dialog, not Markdown/paste parsing. */
export function normalizeLinkUrl(value: string): LinkResult {
  const input = value.trim();
  if (!input) {
    return {ok: false, error: '请输入链接地址；移除链接请使用“移除链接”。'};
  }
  if (/[\s\u0000-\u001f\u007f]/u.test(input)) {
    return {ok: false, error: '链接地址不能包含空格、换行或控制字符。'};
  }

  // A host with a port is not a URI scheme. All other explicit schemes must
  // pass the allowlist, including ones the browser's URL parser accepts.
  const hostWithPort = /^(?:localhost|[^/:?#]+\.[^/:?#]+):\d+(?:[/?#]|$)/i;
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(input) && !hostWithPort.test(input);
  const candidate = hasScheme ? input : `https://${input}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return {ok: false, error: INVALID_ADDRESS};
  }
  if (!['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol)) {
    return {ok: false, error: '仅支持 http、https、mailto 和 tel 链接。'};
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    if (
      !/^https?:\/\/[^/\\]/i.test(candidate) ||
      candidate.includes('\\') ||
      !parsed.hostname ||
      parsed.hostname === 'www.' ||
      parsed.hostname.startsWith('.') ||
      parsed.hostname.includes('..') ||
      (!hasScheme &&
        ((!parsed.hostname.includes('.') && parsed.hostname !== 'localhost') ||
          parsed.username !== '' ||
          parsed.password !== ''))
    ) {
      return {ok: false, error: INVALID_ADDRESS};
    }
  } else {
    let address: string;
    try {
      address = decodeURIComponent(parsed.pathname);
    } catch {
      return {ok: false, error: INVALID_ADDRESS};
    }
    if (parsed.protocol === 'mailto:') {
      if (!address.split(',').every((part) => /^[^\s@<>/:;]+@[^\s@<>/:;]+$/.test(part))) {
        return {ok: false, error: '请输入完整的邮箱链接，例如 mailto:name@example.com。'};
      }
    } else if (!/^\+?[\d().-]+(?:;ext=\d+)?$/.test(address) || !/\d/.test(address)) {
      return {ok: false, error: '请输入完整的电话链接，例如 tel:+8613800138000。'};
    }
    if (/%0[ad]/i.test(candidate)) {
      return {ok: false, error: '链接地址不能包含换行。'};
    }
  }
  const url = sanitizeUrl(parsed.href);
  return url === 'about:blank' ? {ok: false, error: INVALID_ADDRESS} : {ok: true, url};
}

function $linkForNode(node: LexicalNode): LinkNode | null {
  const link = $findMatchingParent(node, $isLinkNode);
  return $isAutoLinkNode(link) && link.getIsUnlinked() ? null : link;
}

export function $getSelectedLinkNode(selection: BaseSelection | null): LinkNode | null {
  if ($isNodeSelection(selection)) {
    const nodes = selection.getNodes();
    const link = nodes[0] ? $linkForNode(nodes[0]) : null;
    return link && nodes.every((node) => $linkForNode(node)?.is(link)) ? link : null;
  }
  if (!$isRangeSelection(selection)) {
    return null;
  }
  let link = $linkForNode(getSelectedNode(selection));
  if (selection.isCollapsed()) {
    if (!link) {
      const node = selection.anchor.getNode();
      // Lexical can place a caret just before a one-character link, or on its
      // parent's element boundary. Keep that link available for editing.
      const adjacent = $isElementNode(node)
        ? node.getChildAtIndex(selection.anchor.offset)
        : selection.anchor.offset === node.getTextContentSize()
          ? node.getNextSibling()
          : null;
      link = adjacent ? $linkForNode(adjacent) : null;
    }
    return link;
  }
  // A selection that crosses into plain text or another link is an insertion
  // target, not an edit of whichever link happens to contain its focus.
  return link && selection.getNodes().every((node) => $isLineBreakNode(node) || $linkForNode(node)?.is(link))
    ? link
    : null;
}

export type LinkEditSession = {
  editor: LexicalEditor;
  selection: RangeSelection | NodeSelection;
  linkKey: NodeKey | null;
  url: string;
};

export function $createLinkEditSession(editor: LexicalEditor): LinkEditSession | null {
  const selection = $getSelection();
  if (!editor.isEditable() || (!$isRangeSelection(selection) && !$isNodeSelection(selection))) {
    return null;
  }
  if ($isNodeSelection(selection) && selection.getNodes().length === 0) {
    return null;
  }
  const link = $getSelectedLinkNode(selection);
  return {editor, linkKey: link?.getKey() ?? null, selection: selection.clone(), url: link?.getURL() ?? ''};
}

/** Restore a clone: Lexical mutates selections as nodes split or move. */
export function $restoreLinkSelection(session: LinkEditSession): boolean {
  if ($getEditor() !== session.editor) {
    return false;
  }
  const selection = session.selection.clone();
  if ($isRangeSelection(selection)) {
    for (const point of [selection.anchor, selection.focus]) {
      const node = $getNodeByKey(point.key);
      if (!node?.isAttached() || (point.type === 'text' ? !$isTextNode(node) : !$isElementNode(node))) {
        return false;
      }
      const size = $isElementNode(node) ? node.getChildrenSize() : node.getTextContentSize();
      point.offset = Math.min(point.offset, size);
    }
  } else if (
    selection.getNodes().length === 0 ||
    selection.getNodes().some((node) => !node.isAttached()) ||
    selection.getNodes().length !== selection._nodes.size
  ) {
    return false;
  }
  $setSelection(selection);
  return true;
}

export function $applyLinkEdit(session: LinkEditSession, value: string): LinkResult {
  const result = normalizeLinkUrl(value);
  if (!result.ok) {
    return result;
  }
  if ($getEditor() !== session.editor || !session.editor.isEditable()) {
    return {ok: false, error: STALE_SELECTION};
  }
  const link = session.linkKey ? $getNodeByKey(session.linkKey) : null;
  if ((session.linkKey && (!$isLinkNode(link) || !link.isAttached())) || !$restoreLinkSelection(session)) {
    return {ok: false, error: STALE_SELECTION};
  }

  if ($isAutoLinkNode(link)) {
    // An explicitly edited automatic link becomes manual so the next text
    // transform cannot silently replace the URL the user just saved.
    const manual = $createLinkNode(result.url, {
      rel: link.getRel(),
      target: link.getTarget(),
      title: link.getTitle(),
    });
    const selection = $getSelection();
    const selectedLink = $isNodeSelection(selection) && selection.has(link.getKey());
    const elementPoints = $isRangeSelection(selection)
      ? [selection.anchor, selection.focus]
          .filter((point) => point.key === link.getKey())
          .map((point) => ({point, offset: point.offset}))
      : [];
    link.replace(manual, true);
    elementPoints.forEach(({point, offset}) => point.set(manual.getKey(), offset, 'element'));
    if ($isNodeSelection(selection) && selectedLink) {
      selection.delete(link.getKey());
      selection.add(manual.getKey());
    }
  } else if ($isLinkNode(link)) {
    link.setURL(result.url);
  } else {
    const selection = $getSelection();
    if ($isRangeSelection(selection) && selection.isCollapsed()) {
      const newLink = $createLinkNode(result.url).append($createTextNode(result.url));
      selection.insertNodes([newLink]);
      newLink.selectEnd();
    } else {
      $toggleLink(result.url);
    }
  }
  return result;
}

export function $removeLink(session: LinkEditSession): boolean {
  if ($getEditor() !== session.editor || !session.editor.isEditable()) {
    return false;
  }
  const link = session.linkKey ? $getNodeByKey(session.linkKey) : null;
  if (!$isLinkNode(link) || !link.isAttached() || !$restoreLinkSelection(session)) {
    return false;
  }
  if ($isAutoLinkNode(link)) {
    // Retain Lexical's opt-out marker so automatic linking does not undo this.
    link.setIsUnlinked(true);
  } else {
    const selection = $getSelection();
    const selectedLink = $isNodeSelection(selection) && selection.has(link.getKey());
    const children = link.getChildren();
    const parent = link.getParentOrThrow();
    const index = link.getIndexWithinParent();
    const elementPoints = $isRangeSelection(selection)
      ? [selection.anchor, selection.focus]
          .filter((point) => point.key === link.getKey())
          .map((point) => ({point, offset: point.offset}))
      : [];
    for (const child of children) {
      link.insertBefore(child);
    }
    link.remove();
    elementPoints.forEach(({point, offset}) => point.set(parent.getKey(), index + offset, 'element'));
    if ($isNodeSelection(selection) && selectedLink) {
      selection.delete(link.getKey());
      children.forEach((child) => selection.add(child.getKey()));
    }
  }
  return true;
}

/** Both existing toolbars request a link with this historical placeholder.
 * Consume it before LinkExtension writes an invalid URL into the document. */
export function registerLinkDraftRequests(
  editor: LexicalEditor,
  onRequest: (session: LinkEditSession) => void,
): () => void {
  return editor.registerCommand(
    TOGGLE_LINK_COMMAND,
    (payload, originatingEditor) => {
      if (payload !== 'https://') {
        return false;
      }
      // Command propagation executes a parent listener in the parent's context.
      // Read the originating editor's pending state, without forcing a commit.
      const session = originatingEditor.read('pending', () => $createLinkEditSession(originatingEditor));
      if (session) {
        onRequest(session);
      }
      return true;
    },
    COMMAND_PRIORITY_HIGH,
  );
}

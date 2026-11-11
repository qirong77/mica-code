/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {caretFromPoint} from '@lexical/clipboard';
import {
  $generateNodesFromDOM,
  defineImportRule,
  DOMImportExtension,
  sel,
} from '@lexical/html';
import {
  $isAutoLinkNode,
  $isLinkNode,
  type LinkNode,
  TOGGLE_LINK_COMMAND,
} from '@lexical/link';
import {$wrapNodeInElement} from '@lexical/utils';
import {
  $createParagraphNode,
  $createRangeSelection,
  $findMatchingParent,
  $getSelection,
  $insertNodes,
  $isNodeSelection,
  $isRootOrShadowRoot,
  $selectAll,
  $setSelection,
  COMMAND_PRIORITY_EDITOR,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  configExtension,
  createCommand,
  defineExtension,
  DRAGOVER_COMMAND,
  DRAGSTART_COMMAND,
  DROP_COMMAND,
  getDOMSelectionFromTarget,
  isHTMLElement,
  type LexicalCommand,
  type LexicalEditor,
  mergeRegister,
  registerEventListener,
  SKIP_DOM_SELECTION_TAG,
} from 'lexical';
import {type JSX, useEffect, useRef, useState} from 'react';

import landscapeImage from '../../images/landscape.jpg';
import yellowFlowerImage from '../../images/yellow-flower.jpg';
import {
  $createImageNode,
  $isImageNode,
  ImageNode,
  type ImagePayload,
} from '../../nodes/ImageNode';
import Button from '../../ui/Button';
import {DialogActions, DialogButtonsList} from '../../ui/Dialog';
import FileInput from '../../ui/FileInput';
import TextInput from '../../ui/TextInput';
import {$imageBlock, $selectImage} from '../../nodes/imageEditing';

/**
 * Google Docs serializes its bullet/check list markers as a leading
 * `<img>` carrying `aria-roledescription="checkbox"`. We never want to
 * import those as ImageNodes — that yields a stray bullet image in the
 * editor where the list marker should be.
 */
function isGoogleDocCheckboxImg(img: HTMLImageElement): boolean {
  return (
    img.parentElement != null &&
    img.parentElement.tagName === 'LI' &&
    img.previousSibling === null &&
    img.getAttribute('aria-roledescription') === 'checkbox'
  );
}

const ImgRule = defineImportRule({
  $import: (_ctx, el, $next) => {
    const src = el.getAttribute('src');
    if (!src || src.startsWith('file:///') || isGoogleDocCheckboxImg(el)) {
      return $next();
    }
    return [
      $createImageNode({
        altText: el.alt,
        height: el.height,
        src,
        width: el.width,
      }),
    ];
  },
  match: sel.tag('img'),
  name: '@lexical/playground/img',
});

/**
 * `<figcaption>` is consumed by the surrounding `<figure>` rule (its
 * content is imported into the ImageNode's nested caption editor), so a
 * top-level handler drops it entirely.
 */
const FigcaptionRule = defineImportRule({
  $import: () => [],
  match: sel.tag('figcaption'),
  name: '@lexical/playground/figcaption',
});

const FigureRule = defineImportRule({
  $import: (ctx, el) => {
    const imported = ctx.$importChildren(el);
    const figcaption = el.querySelector('figcaption');
    if (figcaption) {
      for (const imgNode of imported) {
        if (!$isImageNode(imgNode)) {
          continue;
        }
        imgNode.setShowCaption(true);
        // The caption editor is a nested editor with its own (legacy)
        // import pipeline; route the <figcaption> children through it.
        imgNode.__caption.update(
          () => {
            $selectAll().insertNodes(
              $generateNodesFromDOM(imgNode.__caption, figcaption),
            );
            $setSelection(null);
          },
          {tag: SKIP_DOM_SELECTION_TAG},
        );
      }
    }
    return imported;
  },
  match: sel.tag('figure'),
  name: '@lexical/playground/figure',
});

export type InsertImagePayload = Readonly<ImagePayload>;

export const INSERT_IMAGE_COMMAND: LexicalCommand<InsertImagePayload> =
  createCommand('INSERT_IMAGE_COMMAND');

export function InsertImageUriDialogBody({
  onClick,
}: {
  onClick: (payload: InsertImagePayload) => void;
}) {
  const [src, setSrc] = useState('');
  const [altText, setAltText] = useState('');

  const isDisabled = src === '';

  return (
    <>
      <TextInput
        autoFocus={true}
        label="图片链接"
        placeholder="输入图片链接，如 https://example.com/image.jpg"
        onChange={setSrc}
        value={src}
        data-test-id="image-modal-url-input"
      />
      <TextInput
        label="图片描述"
        placeholder="简要描述图片内容（供无障碍阅读）"
        onChange={setAltText}
        value={altText}
        data-test-id="image-modal-alt-text-input"
      />
      <DialogActions>
        <Button
          data-test-id="image-modal-confirm-btn"
          disabled={isDisabled}
          onClick={() => onClick({altText, src})}>
          插入
        </Button>
      </DialogActions>
    </>
  );
}

export function InsertImageUploadedDialogBody({
  onClick,
}: {
  onClick: (payload: InsertImagePayload) => void;
}) {
  const [src, setSrc] = useState('');
  const [altText, setAltText] = useState('');

  const isDisabled = src === '';

  const loadImage = (files: FileList | null) => {
    const reader = new FileReader();
    reader.onload = function () {
      if (typeof reader.result === 'string') {
        setSrc(reader.result);
      }
      return '';
    };
    if (files !== null) {
      reader.readAsDataURL(files[0]);
    }
  };

  return (
    <>
      <FileInput
        label="上传图片"
        onChange={loadImage}
        accept="image/*"
        data-test-id="image-modal-file-upload"
      />
      <TextInput
        label="图片描述"
        placeholder="简要描述图片内容（供无障碍阅读）"
        onChange={setAltText}
        value={altText}
        data-test-id="image-modal-alt-text-input"
      />
      <DialogActions>
        <Button
          data-test-id="image-modal-file-upload-btn"
          disabled={isDisabled}
          onClick={() => onClick({altText, src})}>
          插入
        </Button>
      </DialogActions>
    </>
  );
}

export function InsertImageDialog({
  activeEditor,
  onClose,
  onInsert,
}: {
  activeEditor: LexicalEditor;
  onClose: () => void;
  onInsert?: (payload: InsertImagePayload) => void;
}): JSX.Element {
  const [mode, setMode] = useState<null | 'url' | 'file'>(null);
  const hasModifier = useRef(false);

  useEffect(() => {
    hasModifier.current = false;
    const handler = (e: KeyboardEvent) => {
      hasModifier.current = e.altKey;
    };
    return registerEventListener(document, 'keydown', handler);
  }, [activeEditor]);

  const onClick = (payload: InsertImagePayload) => {
    if (onInsert) onInsert(payload);
    else activeEditor.dispatchCommand(INSERT_IMAGE_COMMAND, payload);
    onClose();
  };

  return (
    <>
      {!mode && (
        <DialogButtonsList>
          <Button
            data-test-id="image-modal-option-sample"
            onClick={() =>
              onClick(
                hasModifier.current
                  ? {
                      altText:
                        'Daylight fir trees forest glacier green high ice landscape',
                      src: landscapeImage,
                    }
                  : {
                      altText: 'Yellow flower in tilt shift lens',
                      src: yellowFlowerImage,
                    },
              )
            }>
            示例图片
          </Button>
          <Button
            data-test-id="image-modal-option-url"
            onClick={() => setMode('url')}>
            图片链接
          </Button>
          <Button
            data-test-id="image-modal-option-file"
            onClick={() => setMode('file')}>
            本地上传
          </Button>
        </DialogButtonsList>
      )}
      {mode === 'url' && <InsertImageUriDialogBody onClick={onClick} />}
      {mode === 'file' && <InsertImageUploadedDialogBody onClick={onClick} />}
    </>
  );
}

export const ImagesExtension = defineExtension({
  dependencies: [
    configExtension(DOMImportExtension, {
      rules: [FigcaptionRule, FigureRule, ImgRule],
    }),
  ],
  name: '@lexical/playground/Images',
  nodes: [ImageNode],
  register: editor =>
    mergeRegister(
      editor.registerCommand(
        INSERT_IMAGE_COMMAND,
        payload => {
          const imageNode = $createImageNode(payload);
          $insertNodes([imageNode]);
          if ($isRootOrShadowRoot(imageNode.getParentOrThrow())) {
            $wrapNodeInElement(imageNode, $createParagraphNode).selectEnd();
          }

          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
      editor.registerCommand(
        DRAGSTART_COMMAND,
        event => $onDragStart(event),
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        DRAGOVER_COMMAND,
        event => $onDragover(event),
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        DROP_COMMAND,
        event => $onDrop(event, editor),
        COMMAND_PRIORITY_HIGH,
      ),
    ),
});

const TRANSPARENT_IMAGE =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
// Detached element for setDragImage() visual feedback — not inserted into
// any DOM tree, so it does not need shadow-root-aware $getDocument().
const img = document.createElement('img');
img.src = TRANSPARENT_IMAGE;

function $onDragStart(event: DragEvent): boolean {
  const node = $getImageNodeInSelection();
  if (!node) {
    return false;
  }
  const dataTransfer = event.dataTransfer;
  if (!dataTransfer) {
    return false;
  }
  dataTransfer.setData('text/plain', '_');
  dataTransfer.setDragImage(img, 0, 0);
  dataTransfer.setData(
    'application/x-lexical-drag',
    JSON.stringify({
      data: {
        altText: node.__altText,
        height: node.__height,
        key: node.getKey(),
        maxWidth: node.__maxWidth,
        showCaption: node.__showCaption,
        src: node.__src,
        width: node.__width,
      },
      type: 'image',
    }),
  );

  return true;
}

function $onDragover(event: DragEvent): boolean {
  const node = $getImageNodeInSelection();
  if (!node) {
    return false;
  }
  if (!canDropImage(event)) {
    event.preventDefault();
  }
  return false;
}

function $onDrop(event: DragEvent, editor: LexicalEditor): boolean {
  const node = $getImageNodeInSelection();
  if (!node) {
    return false;
  }
  const data = getDragImageData(event);
  if (!data) {
    return false;
  }
  const existingLink = $findMatchingParent(
    node,
    (parent): parent is LinkNode =>
      !$isAutoLinkNode(parent) && $isLinkNode(parent),
  );
  const linkAttributes = existingLink ? {
    url: existingLink.getURL(), target: existingLink.getTarget(),
    rel: existingLink.getRel(), title: existingLink.getTitle(),
  } : null;
  const originalFormat = $imageBlock(node)?.getFormatType();
  event.preventDefault();
  if (canDropImage(event)) {
    const range = getDragSelection(event, editor.getRootElement());
    if (!range || data.key !== node.getKey()) return true;
    const rangeSelection = $createRangeSelection();
    rangeSelection.applyDOMRange(range);
    $setSelection(rangeSelection);
    // Relocate the original node: serializing its nested caption editor into
    // drag data turns it into a plain object and loses its history/identity.
    $insertNodes([node]);
    if ($isRootOrShadowRoot(node.getParentOrThrow())) {
      $wrapNodeInElement(node, $createParagraphNode).selectEnd();
    }
    const targetBlock = $imageBlock(node);
    if (targetBlock?.getChildrenSize() === 1 && originalFormat) targetBlock.setFormat(originalFormat);
    $selectImage(node);
    if (linkAttributes) editor.dispatchCommand(TOGGLE_LINK_COMMAND, linkAttributes);
  }
  return true;
}

function $getImageNodeInSelection(): ImageNode | null {
  const selection = $getSelection();
  if (!$isNodeSelection(selection)) {
    return null;
  }
  const nodes = selection.getNodes();
  if (nodes.length !== 1) return null;
  const node = nodes[0];
  return $isImageNode(node) ? node : null;
}

function getDragImageData(event: DragEvent): null | InsertImagePayload {
  const dragData = event.dataTransfer?.getData('application/x-lexical-drag');
  if (!dragData) {
    return null;
  }
  const {type, data} = JSON.parse(dragData);
  if (type !== 'image') {
    return null;
  }

  return data;
}

declare global {
  interface DragEvent {
    rangeOffset?: number;
    rangeParent?: Node;
  }
}

function canDropImage(event: DragEvent): boolean {
  const target = event.target;
  return !!(
    isHTMLElement(target) &&
    !target.closest('code, span.editor-image') &&
    isHTMLElement(target.parentElement) &&
    target.parentElement.closest('div.ContentEditable__root')
  );
}

function getDragSelection(
  event: DragEvent,
  rootElement: HTMLElement | null,
): Range | null | undefined {
  const domSelection = getDOMSelectionFromTarget(event.target);
  // Pass rootElement so caretFromPoint uses caretPositionFromPoint's
  // shadowRoots option rather than the retargeted caretRangeFromPoint.
  const caret = caretFromPoint(event.clientX, event.clientY, rootElement);
  if (caret !== null) {
    const range = (caret.node.ownerDocument ?? document).createRange();
    range.setStart(caret.node, caret.offset);
    range.collapse(true);
    return range;
  } else if (event.rangeParent && domSelection !== null) {
    domSelection.collapse(event.rangeParent, event.rangeOffset || 0);
    return domSelection.getRangeAt(0);
  }
  // The pre-shadow code returned the caretRangeFromPoint result directly,
  // which could be null when the cursor was over a gap with no text node.
  // The caller ($onDrop above) is written to accept null/undefined here,
  // so preserve the original silent fall-through rather than throwing.
  return null;
}

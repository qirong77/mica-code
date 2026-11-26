/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import './index.css';

import {copyToClipboard} from '@lexical/clipboard';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {DraggableBlockPlugin_EXPERIMENTAL} from '@lexical/react/LexicalDraggableBlockPlugin';
import {$generateHtmlFromNodes} from '@lexical/html';
import {
  $createParagraphNode,
  $getNodeByKey,
  $getSelection,
  $isParagraphNode,
  type NodeKey,
} from 'lexical';
import {type JSX, useCallback, useEffect, useMemo, useRef, useState} from 'react';

import useModal from '../../hooks/useModal';
import {useNotebookSession} from '../../../workspace/NotebookBridge';
import {type ComponentPickerOption, getBaseOptions} from '../ComponentPickerPlugin';
import BlockMenu, {BlockHandleHint, type BlockMenuAction} from './BlockMenu';
import {
  $blockForElement,
  $blockShape,
  $convertBlockShape,
  $deleteTopLevelBlock,
  $isFixedNotebookTitle,
  $selectEntireBlock,
  $shiftBlockIndent,
  type BlockShape,
} from './blockMenuActions';

const DRAGGABLE_BLOCK_MENU_CLASSNAME = 'draggable-block-menu';
/** A pointer that moved further than this is a block drag, not a click. */
const CLICK_SLOP = 4;
/** "在下方添加" offers the blocks Yuque lists there, not the whole catalog. */
const INSERT_TITLES = [
  '正文 Paragraph',
  '标题 2 Heading 2',
  '标题 3 Heading 3',
  '无序列表 Bulleted List',
  '有序列表 Numbered List',
  '待办列表 Check List',
  '引用 Quote',
  '代码块 Code',
  '表格 Table',
  '图片 Image',
  '分隔线 Divider',
  '公式 Equation',
  '组件块 Component',
] as const;

export type BlockRect = {left: number; top: number; bottom: number; right: number};

type OpenMenu = {
  anchor: BlockRect;
  blockRect: BlockRect;
  blockKey: NodeKey;
  shape: BlockShape | null;
};

function isOnMenu(element: HTMLElement): boolean {
  return !!element.closest(`.${DRAGGABLE_BLOCK_MENU_CLASSNAME}`) || !!element.closest('.mica-block-menu');
}

function rectOf(element: Element | null | undefined): BlockRect | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {left: rect.left, top: rect.top, bottom: rect.bottom, right: rect.right};
}

export default function DraggableBlockPlugin({
  anchorElem = document.body,
  protectFirstBlock = false,
}: {
  anchorElem?: HTMLElement;
  protectFirstBlock?: boolean;
}): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const notebookSession = useNotebookSession();
  const [modal, showModal] = useModal();
  const menuRef = useRef<HTMLDivElement>(null);
  const targetLineRef = useRef<HTMLDivElement>(null);
  const [draggableElement, setDraggableElement] = useState<HTMLElement | null>(null);
  const [isTitleBlock, setIsTitleBlock] = useState(false);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const restoreKey = useRef<NodeKey | null>(null);
  const previousMenu = useRef<OpenMenu | null>(null);
  const pointerStart = useRef<{x: number; y: number} | null>(null);
  const draggedRef = useRef(false);

  const insertOptions = useMemo(() => {
    const byTitle = new Map(getBaseOptions(editor, showModal).map(option => [option.title, option]));
    return INSERT_TITLES.map(title => byTitle.get(title)).filter(
      (option): option is ComponentPickerOption => option !== undefined,
    );
  }, [editor, showModal]);

  // Lexical pins the handle to the anchor's left edge (SPACE), but the
  // notebook centres its column inside that anchor: sit next to the text
  // column instead of the block's own edge — code blocks and tables extend
  // past it, and a handle following them would be clipped by the frame.
  const placeHandle = useCallback(
    (element: HTMLElement | null) => {
      const container = menuRef.current;
      if (!container || !element) return;
      const anchorLeft = anchorElem.getBoundingClientRect().left;
      const root = element.closest<HTMLElement>('.ContentEditable__root');
      const blockLeft = element.getBoundingClientRect().left;
      const columnLeft = root
        ? root.getBoundingClientRect().left + (Number.parseFloat(getComputedStyle(root).paddingLeft) || 0)
        : blockLeft;
      container.style.setProperty(
        '--block-handle-left',
        `${Math.max(0, Math.round((columnLeft || blockLeft) - anchorLeft - 28))}px`,
      );
    },
    [anchorElem],
  );

  // Hovering the notebook title must not offer a handle: the title is renamed,
  // never deleted or turned into another block.
  const handleElementChanged = useCallback(
    (element: HTMLElement | null) => {
      setDraggableElement(element);
      placeHandle(element);
      if (!protectFirstBlock || !element) {
        setIsTitleBlock(false);
        return;
      }
      editor.read(() => setIsTitleBlock($isFixedNotebookTitle($blockForElement(element))));
    },
    [editor, placeHandle, protectFirstBlock],
  );

  // A centred column moves with the window and with the editor's own scroll.
  useEffect(() => {
    if (!draggableElement) return;
    let frame = 0;
    const update = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        placeHandle(draggableElement);
      });
    };
    window.addEventListener('resize', update);
    anchorElem.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      anchorElem.removeEventListener('scroll', update, true);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [anchorElem, draggableElement, placeHandle]);

  // The caret goes back to the block the menu acted on, once the card is gone.
  useEffect(() => {
    const closed = previousMenu.current !== null && menu === null;
    previousMenu.current = menu;
    if (!closed) return;
    const key = restoreKey.current;
    restoreKey.current = null;
    if (key) {
      editor.update(() => {
        const node = $getNodeByKey(key);
        if (node && node.isAttached() && 'selectStart' in node && typeof node.selectStart === 'function') {
          node.selectStart();
        }
      });
    }
    queueMicrotask(() => editor.getRootElement()?.focus({preventScroll: true}));
  }, [editor, menu]);

  const closeMenu = useCallback(
    (restoreFocus = false) => {
      if (restoreFocus && menu) restoreKey.current = menu.blockKey;
      setMenu(null);
    },
    [menu],
  );

  const openMenu = useCallback(() => {
    const element = draggableElement;
    const handleRect = rectOf(menuRef.current) ?? rectOf(element);
    const blockRect = rectOf(element);
    if (!element || !handleRect || !blockRect) return;
    let blockKey: NodeKey | null = null;
    let shape: BlockShape | null = null;
    editor.read(() => {
      const block = $blockForElement(element);
      if (!block) return;
      blockKey = block.getKey();
      shape = $blockShape(block);
    });
    if (!blockKey) return;
    setMenu({anchor: handleRect, blockRect, blockKey, shape});
  }, [draggableElement, editor]);

  const runAction = useCallback(
    (action: BlockMenuAction) => {
      const blockKey = menu?.blockKey;
      if (!blockKey) return;

      if (action.type === 'insert') {
        const option = action.option;
        // The option needs its own empty block to land in; blocks that insert a
        // node (table, image, …) push past that placeholder and would leave an
        // empty line above themselves. Drop it after the insert commits — the
        // next update sees the final tree, while a nested one does not.
        let placeholderKey: NodeKey | null = null;
        editor.update(() => {
          const block = $getNodeByKey(blockKey);
          if (!block) return;
          const placeholder = $createParagraphNode();
          block.insertAfter(placeholder);
          placeholder.selectStart();
          placeholderKey = placeholder.getKey();
          option.onSelect('');
        });
        restoreKey.current = placeholderKey;
        setMenu(null);
        if (placeholderKey) {
          const key = placeholderKey;
          editor.update(() => {
            const placeholder = $getNodeByKey(key);
            if (
              $isParagraphNode(placeholder) &&
              placeholder.isAttached() &&
              placeholder.getChildrenSize() <= 1 &&
              placeholder.getTextContent().trim().length === 0
            ) {
              placeholder.remove();
            }
          });
        }
        return;
      }

      if (action.type === 'copy' || action.type === 'cut') {
        let selected = false;
        let payload: {html: string; text: string} | null = null;
        editor.update(() => {
          const block = $getNodeByKey(blockKey);
          if (!block) return;
          selected = $selectEntireBlock(block);
          const selection = $getSelection();
          if (!selected || !selection) return;
          payload = {
            html: $generateHtmlFromNodes(editor, selection),
            text: selection.getTextContent(),
          };
        }, {discrete: true});
        restoreKey.current = blockKey;
        setMenu(null);
        if (!selected || !payload) return;
        const blockPayload = payload as {html: string; text: string};
        // Inside the notebook the editor frame is an opaque sandbox, so the
        // host writes the clipboard; elsewhere the editor does it itself.
        const copied = notebookSession
          ? notebookSession.copyBlock(blockPayload.html, blockPayload.text)
          : copyToClipboard(editor, null).then(
              () => true,
              () => false,
            );
        void copied.then(ok => {
          if (!ok) return;
          if (action.type !== 'cut') return;
          editor.update(() => {
            const block = $getNodeByKey(blockKey);
            if (block && block.isAttached()) $deleteTopLevelBlock(block, {protectFirstBlock});
          });
        });
        return;
      }

      editor.update(
        () => {
          const block = $getNodeByKey(blockKey);
          if (!block) return;
          if (action.type === 'delete') {
            $deleteTopLevelBlock(block, {protectFirstBlock});
          } else if (action.type === 'indent') {
            $shiftBlockIndent(block, action.delta, {protectFirstBlock});
          } else if (action.type === 'shape') {
            $convertBlockShape(block, action.shape, {protectFirstBlock});
          }
        },
        {discrete: true},
      );
      closeMenu(action.type !== 'delete');
    },
    [closeMenu, editor, menu?.blockKey, protectFirstBlock],
  );

  return (
    <>
      {modal}
      {menu ? (
        <BlockMenu
          anchor={menu.anchor}
          blockRect={menu.blockRect}
          shape={menu.shape}
          insertOptions={insertOptions}
          onAction={runAction}
          onClose={restoreFocus => closeMenu(restoreFocus)}
        />
      ) : null}
      <DraggableBlockPlugin_EXPERIMENTAL
        anchorElem={anchorElem}
        menuRef={menuRef}
        targetLineRef={targetLineRef}
        menuComponent={
          <div
            ref={menuRef}
            className={`${DRAGGABLE_BLOCK_MENU_CLASSNAME}${isTitleBlock ? ' is-hidden' : ''}${
              draggableElement ? ' is-visible' : ''
            }${menu ? ' is-open' : ''}`}
            onPointerDown={event => {
              pointerStart.current = {x: event.clientX, y: event.clientY};
              draggedRef.current = false;
            }}
            onPointerMove={event => {
              const start = pointerStart.current;
              if (!start) return;
              if (Math.abs(event.clientX - start.x) > CLICK_SLOP || Math.abs(event.clientY - start.y) > CLICK_SLOP) {
                draggedRef.current = true;
              }
            }}
            onPointerUp={() => {
              pointerStart.current = null;
            }}>
            <button
              type="button"
              className="mica-block-handle"
              data-block-handle
              aria-label="块操作"
              aria-haspopup="menu"
              aria-expanded={menu !== null}
              onClick={() => {
                if (draggedRef.current) {
                  draggedRef.current = false;
                  return;
                }
                if (menu) {
                  closeMenu();
                  return;
                }
                openMenu();
              }}>
              <i className="mica-block-handle__grip" aria-hidden="true" />
              <BlockHandleHint />
            </button>
          </div>
        }
        targetLineComponent={<div ref={targetLineRef} className="draggable-block-target-line" />}
        isOnMenu={isOnMenu}
        onElementChanged={handleElementChanged}
      />
    </>
  );
}

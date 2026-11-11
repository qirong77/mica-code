/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import './index.css';

import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useLexicalEditable} from '@lexical/react/useLexicalEditable';
import {
  $computeTableMapSkipCellCheck,
  $getTableNodeFromLexicalNodeOrThrow,
  $getTableRowIndexFromTableCellNode,
  $isTableCellNode,
  $isTableRowNode,
  getDOMCellFromTarget,
  getTableElement,
  type TableCellNode,
  type TableDOMCell,
  type TableMapType,
  TableNode,
} from '@lexical/table';
import {calculateZoomLevel} from '@lexical/utils';
import {
  $getNearestNodeFromDOMNode,
  isHTMLElement,
  type LexicalEditor,
  mergeRegister,
  type NodeKey,
  registerEventListener,
  registerEventListeners,
  SKIP_SCROLL_INTO_VIEW_TAG,
} from 'lexical';
import * as React from 'react';
import {
  type CSSProperties,
  type JSX,
  type PointerEventHandler,
  type ReactPortal,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {createPortal} from 'react-dom';

type PointerPosition = {
  x: number;
  y: number;
};

type PointerDraggingDirection = 'right' | 'bottom';

const MIN_ROW_HEIGHT = 33;
const MIN_COLUMN_WIDTH = 92;
const ACTIVE_RESIZER_COLOR = '#76b6ff';
export const TABLE_RESIZE_TAG = 'mica-table-resize';

type TableCellResizerOptions = {
  /** Markdown supplies viewport/content-based widths through its layout plugin. */
  initializeColumnWidths?: boolean;
  minColumnWidth?: number;
  minRowHeight?: number;
};

/** Client deltas must use the dragged cell, not the pointer-up target. */
function getElementScale(element: HTMLElement): number {
  const width = element.getBoundingClientRect().width;
  return element.offsetWidth > 0 && width > 0
    ? width / element.offsetWidth
    : calculateZoomLevel(element, true) || 1;
}

function getVisibleBounds(element: HTMLElement) {
  const doc = element.ownerDocument;
  const win = doc.defaultView;
  const bounds = {left: 0, top: 0, right: doc.documentElement.clientWidth, bottom: doc.documentElement.clientHeight};
  for (let parent = element.parentElement; parent && win; parent = parent.parentElement) {
    const style = win.getComputedStyle(parent);
    const rect = parent.getBoundingClientRect();
    if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) {
      bounds.left = Math.max(bounds.left, rect.left);
      bounds.right = Math.min(bounds.right, rect.right);
    }
    if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
      bounds.top = Math.max(bounds.top, rect.top);
      bounds.bottom = Math.min(bounds.bottom, rect.bottom);
    }
  }
  return bounds;
}

function TableCellResizer({
  editor,
  initializeColumnWidths = true,
  minColumnWidth = MIN_COLUMN_WIDTH,
  minRowHeight = MIN_ROW_HEIGHT,
}: {editor: LexicalEditor} & TableCellResizerOptions): JSX.Element {
  const targetRef = useRef<HTMLElement | null>(null);
  const resizerRef = useRef<HTMLDivElement | null>(null);
  const [hasTable, setHasTable] = useState(false);

  const pointerStartPosRef = useRef<PointerPosition | null>(null);
  const pointerScaleRef = useRef(1);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanupRef.current?.(), []);
  const [pointerCurrentPos, updatePointerCurrentPos] =
    useState<PointerPosition | null>(null);

  const [activeCell, updateActiveCell] = useState<TableDOMCell | null>(null);
  const [draggingDirection, updateDraggingDirection] =
    useState<PointerDraggingDirection | null>(null);
  const [hoveredDirection, updateHoveredDirection] =
    useState<PointerDraggingDirection | null>(null);
  const [, refreshGeometry] = useState(0);

  useEffect(() => {
    const Observer = activeCell?.elem.ownerDocument.defaultView?.ResizeObserver;
    if (!activeCell || !Observer) return;
    const observer = new Observer(() => refreshGeometry(value => value + 1));
    observer.observe(activeCell.elem);
    const table = activeCell.elem.closest('table');
    if (table) observer.observe(table);
    return () => observer.disconnect();
  }, [activeCell]);

  const resetState = useCallback(() => {
    updateActiveCell(null);
    targetRef.current = null;
    updateDraggingDirection(null);
    updateHoveredDirection(null);
    pointerStartPosRef.current = null;
  }, []);

  useEffect(() => {
    const tableKeys = new Set<NodeKey>();
    return mergeRegister(
      editor.registerMutationListener(TableNode, nodeMutations => {
        for (const [nodeKey, mutation] of nodeMutations) {
          if (mutation === 'destroyed') {
            tableKeys.delete(nodeKey);
          } else {
            tableKeys.add(nodeKey);
          }
        }
        setHasTable(tableKeys.size > 0);
      }),
      editor.registerNodeTransform(TableNode, tableNode => {
        if (!initializeColumnWidths || tableNode.getColWidths()) {
          return tableNode;
        }

        const numColumns = tableNode.getColumnCount();
        const columnWidth = minColumnWidth;

        tableNode.setColWidths(Array(numColumns).fill(columnWidth));
        return tableNode;
      }),
    );
  }, [editor, initializeColumnWidths, minColumnWidth]);

  useEffect(() => {
    if (!hasTable) {
      return;
    }

    const onPointerMove = (event: PointerEvent) => {
      const target = event.target;
      if (!isHTMLElement(target)) {
        return;
      }

      if (draggingDirection) {
        event.preventDefault();
        event.stopPropagation();
        updatePointerCurrentPos({
          x: event.clientX,
          y: event.clientY,
        });
        return;
      }
      if (resizerRef.current && resizerRef.current.contains(target)) {
        return;
      }

      if (targetRef.current !== target) {
        targetRef.current = target;
        const cell = getDOMCellFromTarget(target);

        if (cell && activeCell?.elem !== cell.elem) {
          editor.read('latest', () => {
            const tableCellNode = $getNearestNodeFromDOMNode(cell.elem);
            if (!$isTableCellNode(tableCellNode) || editor.getElementByKey(tableCellNode.getKey()) !== cell.elem) {
              resetState();
              return;
            }

            const tableNode =
              $getTableNodeFromLexicalNodeOrThrow(tableCellNode);
            const tableElement = getTableElement(
              tableNode,
              editor.getElementByKey(tableNode.getKey()),
            );

            if (!tableElement) {
              resetState();
              return;
            }

            targetRef.current = target;
            updateActiveCell(cell);
          });
        } else if (cell == null) {
          resetState();
        }
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      const isTouchEvent = event.pointerType === 'touch';
      if (isTouchEvent) {
        onPointerMove(event);
      }
    };

    const resizerContainer = resizerRef.current;
    return mergeRegister(
      editor.registerRootListener(rootElement => {
        if (rootElement) {
          return registerEventListeners(rootElement, {
            pointerdown: onPointerDown,
            pointermove: onPointerMove,
          });
        }
      }),
      resizerContainer
        ? registerEventListener(
            resizerContainer,
            'pointermove',
            onPointerMove,
            {
              capture: true,
            },
          )
        : () => {},
      editor.registerRootListener(rootElement => {
        if (!rootElement) return;
        const hideOnScroll = () => {
          if (!draggingDirection) resetState();
        };
        const ownerWindow = rootElement.ownerDocument.defaultView;
        return mergeRegister(
          registerEventListener(rootElement.ownerDocument, 'scroll', hideOnScroll, {capture: true}),
          ownerWindow ? registerEventListener(ownerWindow, 'resize', hideOnScroll) : () => {},
        );
      }),
    );
  }, [activeCell, draggingDirection, editor, resetState, hasTable]);

  const isHeightChanging = (direction: PointerDraggingDirection) => {
    if (direction === 'bottom') {
      return true;
    }
    return false;
  };

  const updateRowHeight = useCallback(
    (heightChange: number) => {
      if (!activeCell) {
        throw new Error('TableCellResizer: Expected active cell.');
      }

      editor.update(
        () => {
          const tableCellNode = $getNearestNodeFromDOMNode(activeCell.elem);
          if (!$isTableCellNode(tableCellNode)) {
            throw new Error('TableCellResizer: Table cell node not found.');
          }

          const tableNode = $getTableNodeFromLexicalNodeOrThrow(tableCellNode);
          const baseRowIndex =
            $getTableRowIndexFromTableCellNode(tableCellNode);
          const tableRows = tableNode.getChildren();

          // Determine if this is a full row merge by checking colspan
          const isFullRowMerge =
            tableCellNode.getColSpan() === tableNode.getColumnCount();

          // For full row merges, apply to first row. For partial merges, apply to last row
          const tableRowIndex = isFullRowMerge
            ? baseRowIndex
            : baseRowIndex + tableCellNode.getRowSpan() - 1;

          if (tableRowIndex >= tableRows.length || tableRowIndex < 0) {
            throw new Error('Expected table cell to be inside of table row.');
          }

          const tableRow = tableRows[tableRowIndex];

          if (!$isTableRowNode(tableRow)) {
            throw new Error('Expected table row');
          }

          let height = tableRow.getHeight();
          if (height === undefined) {
            const rowCells = tableRow.getChildren().filter($isTableCellNode);
            height = Math.min(
              ...rowCells.map(
                // eslint-disable-next-line react-hooks/immutability
                cell => getCellNodeHeight(cell, editor) ?? Infinity,
              ),
            );
          }

          if (!Number.isFinite(height)) return;
          const newHeight = Math.max(height + heightChange, minRowHeight);
          tableRow.setHeight(newHeight);
        },
        {tag: [SKIP_SCROLL_INTO_VIEW_TAG, TABLE_RESIZE_TAG]},
      );
    },
    [activeCell, editor, minRowHeight],
  );

  const getCellNodeHeight = (
    cell: TableCellNode,
    activeEditor: LexicalEditor,
  ): number | undefined => {
    const domCellNode = activeEditor.getElementByKey(cell.getKey());
    return domCellNode?.clientHeight;
  };

  const getCellColumnIndex = (
    tableCellNode: TableCellNode,
    tableMap: TableMapType,
  ) => {
    for (let row = 0; row < tableMap.length; row++) {
      for (let column = 0; column < tableMap[row].length; column++) {
        if (tableMap[row][column].cell.is(tableCellNode)) {
          // The dragged right edge belongs to the last grid column spanned by
          // this cell, not the first one (which differs after merging cells).
          return column + tableCellNode.getColSpan() - 1;
        }
      }
    }
  };

  const updateColumnWidth = useCallback(
    (widthChange: number) => {
      if (!activeCell) {
        throw new Error('TableCellResizer: Expected active cell.');
      }
      editor.update(
        () => {
          const tableCellNode = $getNearestNodeFromDOMNode(activeCell.elem);
          if (!$isTableCellNode(tableCellNode)) {
            throw new Error('TableCellResizer: Table cell node not found.');
          }

          const tableNode = $getTableNodeFromLexicalNodeOrThrow(tableCellNode);
          const [tableMap] = $computeTableMapSkipCellCheck(
            tableNode,
            null,
            null,
          );
          const columnIndex = getCellColumnIndex(tableCellNode, tableMap);
          if (columnIndex === undefined) {
            throw new Error('TableCellResizer: Table column not found.');
          }

          const tableElement = getTableElement(tableNode, editor.getElementByKey(tableNode.getKey()));
          const savedWidths = tableNode.getColWidths();
          const columns = tableElement?.querySelectorAll<HTMLElement>(':scope > colgroup > col');
          const scale = pointerScaleRef.current;
          // Nested-table fitting and CSS can make rendered columns differ from
          // their saved widths. Rebase the whole grid on what the user sees.
          const colWidths = Array.from({length: tableNode.getColumnCount()}, (_, index) => {
            const rendered = columns?.[index]?.getBoundingClientRect().width;
            return rendered && rendered > 0 ? rendered / scale : savedWidths?.[index] ?? minColumnWidth;
          });
          const width = colWidths[columnIndex];
          if (width === undefined) {
            return;
          }
          const newColWidths = [...colWidths];
          const newWidth = Math.max(width + widthChange, minColumnWidth);
          newColWidths[columnIndex] = newWidth;
          tableNode.setColWidths(newColWidths);
        },
        {tag: [SKIP_SCROLL_INTO_VIEW_TAG, TABLE_RESIZE_TAG]},
      );
    },
    [activeCell, editor, minColumnWidth],
  );

  const pointerUpHandler = useCallback(
    (direction: PointerDraggingDirection) => {
      const handler = (event: PointerEvent) => {
        event.preventDefault();
        event.stopPropagation();

        if (!activeCell?.elem.isConnected) {
          resetState();
          resizeCleanupRef.current?.();
          resizeCleanupRef.current = null;
          return;
        }

        if (pointerStartPosRef.current) {
          const {x, y} = pointerStartPosRef.current;

          const zoom = pointerScaleRef.current;

          if (isHeightChanging(direction)) {
            const heightChange = (event.clientY - y) / zoom;
            if (heightChange) updateRowHeight(heightChange);
          } else {
            const widthChange = (event.clientX - x) / zoom;
            if (widthChange) updateColumnWidth(widthChange);
          }

          resetState();
          resizeCleanupRef.current?.();
          resizeCleanupRef.current = null;
        }
      };
      return handler;
    },
    [activeCell, resetState, updateColumnWidth, updateRowHeight],
  );

  const toggleResize = useCallback(
    (
      direction: PointerDraggingDirection,
    ): PointerEventHandler<HTMLDivElement> =>
      event => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.stopPropagation();

        if (!activeCell) {
          throw new Error('TableCellResizer: Expected active cell.');
        }

        pointerStartPosRef.current = {
          x: event.clientX,
          y: event.clientY,
        };
        pointerScaleRef.current = getElementScale(activeCell.elem);
        updatePointerCurrentPos(pointerStartPosRef.current);
        updateDraggingDirection(direction);

        resizeCleanupRef.current?.();
        const cancel = () => {
          resetState();
          resizeCleanupRef.current?.();
          resizeCleanupRef.current = null;
        };
        const ownerWindow = activeCell.elem.ownerDocument.defaultView;
        const pointerId = event.pointerId;
        const captureTarget = event.currentTarget;
        const unregister = mergeRegister(
          registerEventListeners(activeCell.elem.ownerDocument, {
            pointermove: moveEvent => {
              if (moveEvent.pointerId !== pointerId) return;
              moveEvent.preventDefault();
              updatePointerCurrentPos({x: moveEvent.clientX, y: moveEvent.clientY});
            },
            pointerup: upEvent => {
              if (upEvent.pointerId === pointerId) pointerUpHandler(direction)(upEvent);
            },
            pointercancel: cancelEvent => {
              if (cancelEvent.pointerId === pointerId) cancel();
            },
          }),
          registerEventListener(captureTarget, 'lostpointercapture', lostEvent => {
            if (lostEvent.pointerId === pointerId) cancel();
          }),
          ownerWindow ? registerEventListener(ownerWindow, 'blur', cancel) : () => {},
        );
        resizeCleanupRef.current = () => {
          // Remove lostpointercapture before explicitly releasing to avoid
          // recursively cancelling the same drag during normal completion.
          unregister();
          if (captureTarget.hasPointerCapture?.(pointerId)) captureTarget.releasePointerCapture(pointerId);
        };
        // Document listeners alone stop at the iframe edge. Capture keeps the
        // same pointer's up/cancel events routed here after leaving the frame.
        try { captureTarget.setPointerCapture?.(pointerId); } catch { /* Detached/synthetic pointer: document listeners still cancel on blur. */ }
      },
    [activeCell, pointerUpHandler, resetState],
  );

  const getResizers = useCallback(() => {
    if (activeCell?.elem.isConnected) {
      const rect = activeCell.elem.getBoundingClientRect();
      const tableRect = activeCell.elem.closest('table')?.getBoundingClientRect();
      const visible = getVisibleBounds(activeCell.elem);
      // Cell zoom affects drag deltas. Only the body portal's zoom affects its
      // viewport coordinates; mixing the two moves the guide away from the mouse.
      const zoom = calculateZoomLevel(resizerRef.current, true) || 1;
      const zoneWidth = 12;
      const top = Math.max(rect.top, visible.top);
      const bottom = Math.min(rect.bottom, visible.bottom);
      const left = Math.max(rect.left, visible.left);
      const right = Math.min(rect.right, visible.right);
      const styles: Record<string, CSSProperties> = {
        bottom: {
          backgroundColor: 'transparent',
          cursor: 'row-resize',
          display: rect.bottom < visible.top || rect.bottom > visible.bottom || right <= left ? 'none' : undefined,
          height: `${zoneWidth / zoom}px`,
          left: `${left / zoom}px`,
          top: `${(rect.bottom - zoneWidth / 2) / zoom}px`,
          width: `${Math.max(0, right - left) / zoom}px`,
        },
        right: {
          backgroundColor: 'transparent',
          cursor: 'col-resize',
          display: rect.right < visible.left || rect.right > visible.right + 1 || bottom <= top ? 'none' : undefined,
          height: `${Math.max(0, bottom - top) / zoom}px`,
          left: `${(rect.right - zoneWidth / 2) / zoom}px`,
          top: `${top / zoom}px`,
          width: `${zoneWidth / zoom}px`,
        },
      };

      if (draggingDirection && pointerCurrentPos && tableRect) {
        const tableLeft = Math.max(tableRect.left, visible.left);
        const tableTop = Math.max(tableRect.top, visible.top);
        const tableRight = Math.min(tableRect.right, visible.right);
        const tableBottom = Math.min(tableRect.bottom, visible.bottom);
        styles[draggingDirection].display = undefined;
        styles[draggingDirection].pointerEvents = 'none';
        if (isHeightChanging(draggingDirection)) {
          styles.bottom.left = `${tableLeft / zoom}px`;
          styles.bottom.top = `${pointerCurrentPos.y / zoom}px`;
          styles.bottom.height = '3px';
          styles.bottom.width = `${Math.max(0, tableRight - tableLeft) / zoom}px`;
        } else {
          styles.right.top = `${tableTop / zoom}px`;
          styles.right.left = `${pointerCurrentPos.x / zoom}px`;
          styles.right.width = '3px';
          styles.right.height = `${Math.max(0, tableBottom - tableTop) / zoom}px`;
        }

        styles[draggingDirection].backgroundColor = '#adf';
        styles[draggingDirection].mixBlendMode = 'unset';
      } else if (!draggingDirection && hoveredDirection === 'right') {
        const halfZoneWidth = zoneWidth / zoom / 2;
        const highlightWidth = 2 / zoom;
        const highlightStart = halfZoneWidth - highlightWidth / 2;
        styles.right.backgroundImage = `linear-gradient(90deg, transparent ${highlightStart}px, ${ACTIVE_RESIZER_COLOR} ${highlightStart}px, ${ACTIVE_RESIZER_COLOR} ${
          highlightStart + highlightWidth
        }px, transparent ${highlightStart + highlightWidth}px)`;
        styles.right.mixBlendMode = 'unset';
        if (tableRect) {
          const tableTop = Math.max(tableRect.top, visible.top);
          const tableBottom = Math.min(tableRect.bottom, visible.bottom);
          styles.right.top = `${tableTop / zoom}px`;
          styles.right.height = `${Math.max(0, tableBottom - tableTop) / zoom}px`;
        }
      }

      return styles;
    }

    return {bottom: null, right: null};
  }, [activeCell, draggingDirection, hoveredDirection, pointerCurrentPos]);

  const handlePointerEnter = useCallback(
    (
      direction: PointerDraggingDirection,
    ): PointerEventHandler<HTMLDivElement> =>
      () => {
        if (!draggingDirection) {
          updateHoveredDirection(direction);
        }
      },
    [draggingDirection],
  );

  const handlePointerLeave = useCallback(() => {
    if (!draggingDirection) {
      updateHoveredDirection(null);
    }
  }, [draggingDirection]);

  const resizerStyles = getResizers();

  return (
    <div ref={resizerRef}>
      {activeCell != null && (
        <>
          <div
            className="TableCellResizer__resizer TableCellResizer__ui"
            style={resizerStyles.right || undefined}
            title="拖动调整列宽"
            data-table-resizer="column"
            onPointerEnter={handlePointerEnter('right')}
            onPointerLeave={handlePointerLeave}
            onPointerDown={toggleResize('right')}
          />
          <div
            className="TableCellResizer__resizer TableCellResizer__ui"
            style={resizerStyles.bottom || undefined}
            title="拖动调整行高"
            data-table-resizer="row"
            onPointerDown={toggleResize('bottom')}
          />
        </>
      )}
    </div>
  );
}

export default function TableCellResizerPlugin({initializeColumnWidths, minColumnWidth, minRowHeight}: TableCellResizerOptions): null | ReactPortal {
  const [editor] = useLexicalComposerContext();
  const isEditable = useLexicalEditable();

  const portalTarget =
    editor.getRootElement()?.ownerDocument?.body ?? document.body;

  return useMemo(
    () =>
      isEditable
        ? createPortal(<TableCellResizer editor={editor} initializeColumnWidths={initializeColumnWidths} minColumnWidth={minColumnWidth} minRowHeight={minRowHeight} />, portalTarget)
        : null,
    [editor, isEditable, portalTarget, initializeColumnWidths, minColumnWidth, minRowHeight],
  );
}

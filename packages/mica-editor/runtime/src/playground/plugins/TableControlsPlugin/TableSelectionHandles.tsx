import {IconDragDot, IconDragDotVertical} from '@arco-design/web-react/icon';
import {autoUpdate} from '@floating-ui/react';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {
  $computeTableMap,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  getTableElement,
} from '@lexical/table';
import {$getNodeByKey} from 'lexical';
import {
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {createPortal} from 'react-dom';

import type {TableContext} from './tableActions';

import './handles.css';

type Axis = 'row' | 'column';
type Props = {
  context: TableContext;
  onSelect: (axis: Axis | 'table', start: number, end: number) => void;
  onMenu: (axis: Axis, index: number, event: ReactMouseEvent) => void;
  onMove: (axis: Axis, from: number, to: number) => void;
};
type Box = {left: number; right: number; top: number; bottom: number};
type CellDOM = {
  element: HTMLElement;
  row: number;
  column: number;
  rowSpan: number;
  columnSpan: number;
};
type TableDOM = {
  table: HTMLTableElement;
  host: HTMLElement;
  cells: CellDOM[];
  rows: HTMLElement[];
  rowCount: number;
  columnCount: number;
  columnWidths: readonly number[] | undefined;
  frozenRows: boolean;
  frozenColumns: boolean;
  simple: boolean;
};
type Layout = {
  tableKey: string;
  ownerDocument: Document;
  table: Box;
  visible: Box;
  columnEdges: number[];
  rowEdges: number[];
  railTop: number;
  railLeft: number;
  showColumns: boolean;
  showRows: boolean;
  compact: boolean;
  simple: boolean;
};
type SelectionDrag = {
  axis: Axis;
  anchor: number;
  origin: number;
  last: number;
  pointerId: number;
  target: HTMLButtonElement;
};
type MoveDrag = {axis: Axis; from: number};
type DropTarget = MoveDrag & {to: number; edge: number};

const RAIL_SIZE = 12;
const RAIL_OFFSET = 13;
const VIEWPORT_PADDING = 3;
const STRUCTURE_TAGS = new Set(['TABLE', 'TR', 'TD', 'TH', 'TBODY', 'THEAD', 'TFOOT', 'COL', 'COLGROUP']);
const CLIPPING_OVERFLOW = /^(auto|scroll|hidden|clip)$/;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

/** Missing interior edges of a merged cell are interpolated, never physical cell indices. */
function resolveEdges(
  count: number,
  samples: number[][],
  start: number,
  end: number,
  weights?: readonly number[],
): number[] {
  const edges = Array.from({length: count + 1}, (_, index) => {
    const values = samples[index];
    if (!values?.length) return Number.NaN;
    values.sort((a, b) => a - b);
    return clamp(values[Math.floor(values.length / 2)], start, end);
  });
  if (!Number.isFinite(edges[0])) edges[0] = start;
  if (!Number.isFinite(edges[count])) edges[count] = end;
  for (let left = 0; left < count;) {
    let right = left + 1;
    while (right < count && !Number.isFinite(edges[right])) right++;
    let total = 0;
    for (let index = left; index < right; index++) total += Math.max(1, weights?.[index] || 1);
    let consumed = 0;
    for (let index = left + 1; index < right; index++) {
      consumed += Math.max(1, weights?.[index - 1] || 1);
      edges[index] = edges[left] + (edges[right] - edges[left]) * consumed / total;
    }
    left = right;
  }
  // Invalid/transient table geometry must not put controls outside the table.
  for (let index = 1; index <= count; index++) edges[index] = Math.max(edges[index - 1], edges[index]);
  return edges;
}

function measureTable(structure: TableDOM, tableKey: string): Layout | null {
  const {table, host, cells, rowCount, columnCount} = structure;
  const doc = table.ownerDocument;
  const win = doc.defaultView;
  if (!win || !table.isConnected || !rowCount || !columnCount) return null;
  const rect = table.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;

  const viewport: Box = {
    left: VIEWPORT_PADDING,
    right: doc.documentElement.clientWidth - VIEWPORT_PADDING,
    top: VIEWPORT_PADDING,
    bottom: doc.documentElement.clientHeight - VIEWPORT_PADDING,
  };
  const clip = {...viewport};
  let railClipTop = viewport.top;
  let railClipBottom = viewport.bottom;
  let railClipLeft = viewport.left;
  let railClipRight = viewport.right;
  for (let parent = table.parentElement; parent; parent = parent.parentElement) {
    const style = win.getComputedStyle(parent);
    const clipsX = CLIPPING_OVERFLOW.test(style.overflowX);
    const clipsY = CLIPPING_OVERFLOW.test(style.overflowY);
    if (!clipsX && !clipsY) continue;
    const parentRect = parent.getBoundingClientRect();
    const left = parentRect.left + parent.clientLeft;
    const top = parentRect.top + parent.clientTop;
    const isTableScroller = host !== table && (parent === host || parent === table.parentElement);
    if (clipsX) {
      clip.left = Math.max(clip.left, left);
      clip.right = Math.min(clip.right, left + parent.clientWidth);
      if (!isTableScroller) {
        railClipLeft = Math.max(railClipLeft, left);
        railClipRight = Math.min(railClipRight, left + parent.clientWidth);
      }
    }
    if (clipsY) {
      clip.top = Math.max(clip.top, top);
      clip.bottom = Math.min(clip.bottom, top + parent.clientHeight);
      // A horizontal table scroller has no room above it. Its portal rail may
      // occupy the 13px gutter, but still respects the outer editor's clipping.
      if (!isTableScroller) {
        railClipTop = Math.max(railClipTop, top);
        railClipBottom = Math.min(railClipBottom, top + parent.clientHeight);
      }
    }
  }
  const visible: Box = {
    left: Math.max(rect.left, clip.left),
    right: Math.min(rect.right, clip.right),
    top: Math.max(rect.top, clip.top),
    bottom: Math.min(rect.bottom, clip.bottom),
  };
  if (visible.right <= visible.left || visible.bottom <= visible.top) return null;

  const columnSamples: number[][] = Array.from({length: columnCount + 1}, () => []);
  const rowSamples: number[][] = Array.from({length: rowCount + 1}, () => []);
  for (const cell of cells) {
    const cellRect = cell.element.getBoundingClientRect();
    if (cellRect.width <= 0 || cellRect.height <= 0) continue;
    // Sticky first cells move independently of the logical grid when scrolled.
    const left = structure.frozenColumns && cell.column === 0 ? rect.left : cellRect.left;
    const top = structure.frozenRows && cell.row === 0 ? rect.top : cellRect.top;
    columnSamples[cell.column]?.push(left);
    columnSamples[Math.min(columnCount, cell.column + cell.columnSpan)]?.push(left + cellRect.width);
    rowSamples[cell.row]?.push(top);
    rowSamples[Math.min(rowCount, cell.row + cell.rowSpan)]?.push(top + cellRect.height);
  }
  // Actual <tr> geometry also exposes row boundaries completely covered by a rowspan.
  structure.rows.forEach((row, index) => {
    const rowRect = row.getBoundingClientRect();
    if (rowRect.height <= 0) return;
    rowSamples[index]?.push(rowRect.top);
    rowSamples[index + 1]?.push(rowRect.bottom);
  });
  const railTop = rect.top - RAIL_OFFSET;
  const railLeft = Math.max(railClipLeft, visible.left - RAIL_OFFSET);
  return {
    tableKey,
    ownerDocument: doc,
    table: {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom},
    visible,
    columnEdges: resolveEdges(columnCount, columnSamples, rect.left, rect.right, structure.columnWidths),
    rowEdges: resolveEdges(rowCount, rowSamples, rect.top, rect.bottom),
    railTop,
    railLeft,
    showColumns: railTop >= railClipTop && railTop + RAIL_SIZE <= railClipBottom,
    showRows: railLeft + RAIL_SIZE <= railClipRight,
    compact: doc.documentElement.clientWidth <= 600,
    simple: structure.simple,
  };
}

function sameLayout(a: Layout | null, b: Layout | null) {
  if (!a || !b) return a === b;
  if (a.tableKey !== b.tableKey || a.ownerDocument !== b.ownerDocument || a.simple !== b.simple ||
      a.compact !== b.compact || a.showColumns !== b.showColumns || a.showRows !== b.showRows ||
      a.columnEdges.length !== b.columnEdges.length || a.rowEdges.length !== b.rowEdges.length) return false;
  const aValues = [...Object.values(a.table), ...Object.values(a.visible), a.railTop, a.railLeft, ...a.columnEdges, ...a.rowEdges];
  const bValues = [...Object.values(b.table), ...Object.values(b.visible), b.railTop, b.railLeft, ...b.columnEdges, ...b.rowEdges];
  return aValues.length === bValues.length && aValues.every((value, index) => Math.abs(value - bValues[index]) < 0.25);
}

function findDrop(layout: Layout, move: MoveDrag, x: number, y: number): DropTarget | null {
  const {visible, railTop, railLeft} = layout;
  if (!layout.simple || x < railLeft - 3 || x > visible.right + 3 ||
      y < Math.max(0, railTop - 3) || y > visible.bottom + 3 ||
      (move.axis === 'row' && y < visible.top - 3) ||
      (move.axis === 'column' && x < visible.left - 3)) return null;
  const edges = move.axis === 'row' ? layout.rowEdges : layout.columnEdges;
  const position = move.axis === 'row' ? y : x;
  let slot = edges.length - 1;
  for (let index = 0; index < edges.length - 1; index++) {
    if (position < (edges[index] + edges[index + 1]) / 2) {
      slot = index;
      break;
    }
  }
  const to = clamp(slot > move.from ? slot - 1 : slot, 0, edges.length - 2);
  return to === move.from ? null : {...move, to, edge: edges[slot]};
}

export default function TableSelectionHandles({context, onSelect, onMenu, onMove}: Props) {
  const [editor] = useLexicalComposerContext();
  const [layout, setLayout] = useState<Layout | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [selectionDrag, setSelectionDrag] = useState<{axis: Axis; origin: number} | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<Layout | null>(null);
  const propsRef = useRef({context, onSelect, onMenu, onMove});
  propsRef.current = {context, onSelect, onMenu, onMove};
  const anchorRef = useRef<{axis: Axis; index: number; tableKey: string} | null>(null);
  const selectionDragRef = useRef<SelectionDrag | null>(null);
  const moveRef = useRef<MoveDrag | null>(null);
  const pointerFrameRef = useRef<number | null>(null);
  const pendingPointerRef = useRef<{x: number; y: number} | null>(null);

  useLayoutEffect(() => {
    const root = editor.getRootElement();
    const doc = root?.ownerDocument;
    const win = doc?.defaultView;
    if (!root || !doc || !win) return;
    let disposed = false;
    let frame: number | null = null;
    let structure: TableDOM | null = null;
    let needsMap = true;
    let observedTable: HTMLTableElement | null = null;
    let cleanupLayoutShift: (() => void) | undefined;
    let ancestors: HTMLElement[] = [];

    const schedule = () => {
      if (!disposed && frame === null) frame = win.requestAnimationFrame(measure);
    };
    const resizeObserver = new ResizeObserver(schedule);
    const mutationObserver = new MutationObserver(records => {
      let changed = false;
      for (const record of records) {
        if (record.type === 'attributes') {
          if (record.attributeName === 'colspan' || record.attributeName === 'rowspan') {
            needsMap = true;
            changed = true;
          } else if (record.target === observedTable ||
              (record.target.nodeType === 1 && (record.target as Element).tagName === 'COL')) {
            changed = true;
          }
        } else if ([...record.addedNodes, ...record.removedNodes].some(node =>
          node.nodeType === 1 && STRUCTURE_TAGS.has((node as Element).tagName))) {
          needsMap = true;
          changed = true;
        }
      }
      if (changed) schedule();
    });

    const readStructure = (): TableDOM | null => editor.getEditorState().read(() => {
      const table = $getNodeByKey(context.tableKey);
      if (!$isTableNode(table) || !table.isAttached()) return null;
      for (const row of table.getChildren()) {
        if (!$isTableRowNode(row) || row.getChildren().some(cell => !$isTableCellNode(cell))) return null;
      }
      const host = editor.getElementByKey(table.getKey());
      const element = getTableElement(table, host);
      const firstRow = table.getFirstChild();
      const firstCell = $isTableRowNode(firstRow) ? firstRow.getFirstChild() : null;
      if (!host || !element || !$isTableCellNode(firstCell)) return null;
      const [map] = $computeTableMap(table, firstCell, firstCell);
      const rowCount = map.length;
      const columnCount = Math.max(0, ...map.map(row => row.length));
      const seen = new Set<string>();
      const cells: CellDOM[] = [];
      let simple = rowCount > 0 && columnCount > 0;
      for (const row of map) {
        if (row.length !== columnCount) simple = false;
        for (let column = 0; column < columnCount; column++) {
          const item = row[column];
          if (!item) {simple = false; continue;}
          const key = item.cell.getKey();
          if (seen.has(key)) continue;
          seen.add(key);
          const cellElement = editor.getElementByKey(key);
          const rowSpan = item.cell.getRowSpan();
          const columnSpan = item.cell.getColSpan();
          if (rowSpan !== 1 || columnSpan !== 1) simple = false;
          if (cellElement) cells.push({
            element: cellElement, row: item.startRow, column: item.startColumn, rowSpan, columnSpan,
          });
        }
      }
      return {
        table: element, host, cells, rowCount, columnCount,
        rows: table.getChildren().map(row => editor.getElementByKey(row.getKey()))
          .filter((element): element is HTMLElement => element !== null),
        columnWidths: table.getColWidths(), simple,
        frozenRows: table.getFrozenRows() > 0, frozenColumns: table.getFrozenColumns() > 0,
      };
    });

    const observe = (next: TableDOM | null) => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      cleanupLayoutShift?.();
      cleanupLayoutShift = undefined;
      observedTable = next?.table || null;
      ancestors = [];
      if (!next) return;
      for (let parent = next.table.parentElement; parent; parent = parent.parentElement) ancestors.push(parent);
      const elements = new Set<HTMLElement>([
        next.table, ...next.cells.map(cell => cell.element), ...next.rows, ...ancestors,
      ]);
      elements.forEach(element => resizeObserver.observe(element));
      mutationObserver.observe(next.table, {
        childList: true, subtree: true, attributes: true,
        // Ignore selection highlight classes; they must not remeasure the grid
        // on every selection update or keystroke.
        attributeFilter: ['colspan', 'rowspan', 'style'],
      });
      // Position-only shifts (e.g. an image loading before the table) do not
      // need a permanent animation loop or a full grid read on every key.
      cleanupLayoutShift = autoUpdate(next.table, null, schedule, {
        ancestorScroll: false, ancestorResize: false, elementResize: false, layoutShift: true,
      });
    };

    function measure() {
      frame = null;
      if (disposed) return;
      if (needsMap || !structure?.table.isConnected) {
        structure = readStructure();
        needsMap = false;
        observe(structure);
      }
      const next = structure ? measureTable(structure, context.tableKey) : null;
      layoutRef.current = next;
      setLayout(previous => sameLayout(previous, next) ? previous : next);
    }

    const onScroll = (event: Event) => {
      if (event.target === doc || event.target === win || ancestors.includes(event.target as HTMLElement)) schedule();
    };
    const unregister = editor.registerUpdateListener(({dirtyElements}) => {
      // Descendant text edits mark a table indirectly dirty (false). Only an
      // explicit table change needs a new map; cell topology is observed above.
      if (dirtyElements.get(context.tableKey) === true) {
        needsMap = true;
        schedule();
      }
    });
    doc.addEventListener('scroll', onScroll, {capture: true, passive: true});
    win.addEventListener('resize', schedule);
    win.visualViewport?.addEventListener('resize', schedule);
    win.visualViewport?.addEventListener('scroll', schedule);
    measure();
    return () => {
      disposed = true;
      if (frame !== null) win.cancelAnimationFrame(frame);
      unregister();
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      cleanupLayoutShift?.();
      doc.removeEventListener('scroll', onScroll, true);
      win.removeEventListener('resize', schedule);
      win.visualViewport?.removeEventListener('resize', schedule);
      win.visualViewport?.removeEventListener('scroll', schedule);
      layoutRef.current = null;
    };
  }, [editor, context.tableKey]);

  const finishSelection = useCallback(() => {
    const drag = selectionDragRef.current;
    selectionDragRef.current = null;
    if (drag) setSelectionDrag(null);
    pendingPointerRef.current = null;
    const win = drag?.target.ownerDocument.defaultView;
    if (pointerFrameRef.current !== null) {
      win?.cancelAnimationFrame(pointerFrameRef.current);
      pointerFrameRef.current = null;
    }
    if (drag) {
      try {
        if (drag.target.hasPointerCapture(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
      } catch { /* The button may have been removed with its table. */ }
    }
  }, []);

  const selectAtPoint = useCallback((x: number, y: number) => {
    const drag = selectionDragRef.current;
    const geometry = layoutRef.current;
    if (!drag || !geometry) return;
    const hit = geometry.ownerDocument.elementFromPoint(x, y)?.closest<HTMLElement>('[data-table-selection-axis]');
    let index: number | undefined;
    if (hit && rootRef.current?.contains(hit) && hit.dataset.tableSelectionAxis === drag.axis) {
      index = Number(hit.dataset.tableSelectionIndex);
    } else {
      // A little tolerance around a 12px rail makes touch/pen dragging usable.
      const isColumn = drag.axis === 'column';
      const nearRail = isColumn
        ? geometry.showColumns && y >= geometry.railTop - 6 && y <= geometry.railTop + RAIL_SIZE + 6 && x >= geometry.visible.left && x <= geometry.visible.right
        : geometry.showRows && x >= geometry.railLeft - 6 && x <= geometry.railLeft + RAIL_SIZE + 6 && y >= geometry.visible.top && y <= geometry.visible.bottom;
      if (nearRail) {
        const edges = isColumn ? geometry.columnEdges : geometry.rowEdges;
        const position = isColumn ? x : y;
        const found = edges.findIndex((edge, i) => i < edges.length - 1 && position >= edge && position <= edges[i + 1]);
        if (found >= 0) index = found;
      }
    }
    if (index === undefined || !Number.isInteger(index) || index === drag.last) return;
    drag.last = index;
    propsRef.current.onSelect(drag.axis, Math.min(drag.anchor, index), Math.max(drag.anchor, index));
  }, []);

  useEffect(() => {
    const doc = editor.getRootElement()?.ownerDocument;
    const win = doc?.defaultView;
    if (!doc || !win) return;
    anchorRef.current = null;
    moveRef.current = null;
    setDrop(null);
    const pointerMove = (event: PointerEvent) => {
      if (event.pointerId !== selectionDragRef.current?.pointerId) return;
      event.preventDefault();
      pendingPointerRef.current = {x: event.clientX, y: event.clientY};
      if (pointerFrameRef.current === null) pointerFrameRef.current = win.requestAnimationFrame(() => {
        pointerFrameRef.current = null;
        const point = pendingPointerRef.current;
        if (point) selectAtPoint(point.x, point.y);
      });
    };
    const pointerUp = (event: PointerEvent) => {
      if (event.pointerId !== selectionDragRef.current?.pointerId) return;
      selectAtPoint(event.clientX, event.clientY);
      finishSelection();
    };
    const pointerCancel = (event: PointerEvent) => {
      if (event.pointerId === selectionDragRef.current?.pointerId) finishSelection();
    };
    const clearMove = () => {moveRef.current = null; setDrop(null);};
    const blur = () => {finishSelection(); clearMove();};
    const dragOver = (event: DragEvent) => {
      const move = moveRef.current;
      const geometry = layoutRef.current;
      if (!move || !geometry) return;
      const next = findDrop(geometry, move, event.clientX, event.clientY);
      const inTable = event.clientX >= geometry.railLeft - 3 && event.clientX <= geometry.visible.right + 3 &&
        event.clientY >= Math.max(0, geometry.railTop - 3) && event.clientY <= geometry.visible.bottom + 3;
      if (inTable) {
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      }
      setDrop(previous => previous?.axis === next?.axis && previous?.to === next?.to && previous?.edge === next?.edge ? previous : next);
    };
    const dropMove = (event: DragEvent) => {
      const move = moveRef.current;
      if (!move) return;
      event.preventDefault();
      event.stopPropagation();
      const geometry = layoutRef.current;
      const target = geometry ? findDrop(geometry, move, event.clientX, event.clientY) : null;
      clearMove();
      if (target) propsRef.current.onMove(target.axis, target.from, target.to);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') blur();
    };
    doc.addEventListener('pointermove', pointerMove, {capture: true, passive: false});
    doc.addEventListener('pointerup', pointerUp, true);
    doc.addEventListener('pointercancel', pointerCancel, true);
    doc.addEventListener('dragover', dragOver, true);
    doc.addEventListener('drop', dropMove, true);
    doc.addEventListener('dragend', clearMove, true);
    doc.addEventListener('keydown', escape, true);
    win.addEventListener('blur', blur);
    return () => {
      finishSelection();
      moveRef.current = null;
      doc.removeEventListener('pointermove', pointerMove, true);
      doc.removeEventListener('pointerup', pointerUp, true);
      doc.removeEventListener('pointercancel', pointerCancel, true);
      doc.removeEventListener('dragover', dragOver, true);
      doc.removeEventListener('drop', dropMove, true);
      doc.removeEventListener('dragend', clearMove, true);
      doc.removeEventListener('keydown', escape, true);
      win.removeEventListener('blur', blur);
    };
  }, [editor, context.tableKey, finishSelection, selectAtPoint]);

  const selectionAnchor = (axis: Axis, index: number, extend: boolean) => {
    const saved = anchorRef.current;
    const minimum = axis === 'row' ? context.minRow : context.minColumn;
    const maximum = axis === 'row' ? context.maxRow : context.maxColumn;
    const full = axis === 'row'
      ? context.minColumn === 0 && context.maxColumn === context.columns - 1
      : context.minRow === 0 && context.maxRow === context.rows - 1;
    const savedValid = saved?.axis === axis && saved.tableKey === context.tableKey &&
      full && saved.index >= minimum && saved.index <= maximum;
    const anchor = extend
      ? savedValid ? saved.index : minimum
      : index;
    anchorRef.current = {axis, index: anchor, tableKey: context.tableKey};
    return anchor;
  };
  const select = (axis: Axis, index: number, extend: boolean) => {
    const anchor = selectionAnchor(axis, index, extend);
    onSelect(axis, Math.min(anchor, index), Math.max(anchor, index));
  };
  const startSelection = (axis: Axis, index: number, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    finishSelection();
    const anchor = selectionAnchor(axis, index, event.shiftKey);
    selectionDragRef.current = {axis, anchor, origin: index, last: index, pointerId: event.pointerId, target: event.currentTarget};
    setSelectionDrag({axis, origin: index});
    try {event.currentTarget.setPointerCapture(event.pointerId);} catch { /* Document listeners still clean up. */ }
    onSelect(axis, Math.min(anchor, index), Math.max(anchor, index));
  };
  const openMenu = (axis: Axis, index: number, event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    finishSelection();
    const alreadySelected = axis === 'row'
      ? context.minColumn === 0 && context.maxColumn === context.columns - 1 && index >= context.minRow && index <= context.maxRow
      : context.minRow === 0 && context.maxRow === context.rows - 1 && index >= context.minColumn && index <= context.maxColumn;
    if (!alreadySelected) select(axis, index, false);
    onMenu(axis, index, event);
  };
  const startMove = (axis: Axis, index: number, event: ReactDragEvent<HTMLButtonElement>) => {
    const current = propsRef.current.context;
    const single = axis === 'row' ? current.minRow === index && current.maxRow === index
      : current.minColumn === index && current.maxColumn === index;
    const full = axis === 'row'
      ? current.minColumn === 0 && current.maxColumn === current.columns - 1
      : current.minRow === 0 && current.maxRow === current.rows - 1;
    if (!layoutRef.current?.simple || !current.simple || !single || !full) {event.preventDefault(); return;}
    finishSelection();
    event.stopPropagation();
    moveRef.current = {axis, from: index};
    setDrop(null);
    event.dataTransfer.effectAllowed = 'move';
    // No text/html payload: dropping outside this table must not insert content.
    event.dataTransfer.setData('application/x-lexical-table-axis', `${axis}:${index}`);
  };

  if (!layout || layout.tableKey !== context.tableKey) return null;
  const fullRows = context.minColumn === 0 && context.maxColumn === context.columns - 1;
  const fullColumns = context.minRow === 0 && context.maxRow === context.rows - 1;
  const allSelected = fullRows && fullColumns;
  const rowCount = context.maxRow - context.minRow + 1;
  const columnCount = context.maxColumn - context.minColumn + 1;

  const renderRail = (axis: Axis) => {
    const isColumn = axis === 'column';
    if (isColumn ? !layout.showColumns : !layout.showRows) return null;
    const edges = isColumn ? layout.columnEdges : layout.rowEdges;
    const clipStart = isColumn ? layout.visible.left : layout.visible.top;
    const clipEnd = isColumn ? layout.visible.right : layout.visible.bottom;
    const minimum = isColumn ? context.minColumn : context.minRow;
    const maximum = isColumn ? context.maxColumn : context.maxRow;
    const full = isColumn ? fullColumns : fullRows;
    const count = maximum - minimum + 1;
    const label = isColumn ? '列' : '行';
    const compactIndex = selectionDrag?.axis === axis ? selectionDrag.origin : minimum;
    const bands = edges.slice(0, -1).map((start, index) => ({
      index, start: Math.max(start, clipStart), end: Math.min(edges[index + 1], clipEnd),
    })).filter(band => band.end - band.start >= 4 && (!layout.compact || band.index === compactIndex));
    const countIndex = bands.find(band => full && band.index >= minimum && band.index <= maximum)?.index;
    const railStyle: CSSProperties = isColumn
      ? {left: clipStart, top: layout.railTop, width: clipEnd - clipStart, height: RAIL_SIZE}
      : {left: layout.railLeft, top: clipStart, width: RAIL_SIZE, height: clipEnd - clipStart};
    return <div className={`table-selection-rail is-${axis}`} style={railStyle} role="group" aria-label={`表格${label}选择`}>
      {bands.map(({index, start, end}) => {
        const active = full && index >= minimum && index <= maximum;
        const canMove = layout.simple && context.simple && active && count === 1 &&
          end - start >= (isColumn ? 28 : 32) && !selectionDrag;
        const style: CSSProperties = isColumn
          ? {left: start - clipStart, top: 0, width: end - start, height: RAIL_SIZE}
          : {left: 0, top: start - clipStart, width: RAIL_SIZE, height: end - start};
        const gripStyle: CSSProperties = isColumn
          ? {right: 1, top: 0} : {left: 0, bottom: 1};
        return <div className="table-selection-handle-slot" style={style} key={index}>
          <button type="button" className={`table-selection-handle is-${axis}${active ? ' is-active' : ''}${canMove ? ' has-grip' : ''}`}
            aria-label={`选中第 ${index + 1} ${label}`} aria-pressed={active}
            title={`第 ${index + 1} ${label} · 单击选择，Shift 连续选择，右键更多操作`}
            data-table-selection-axis={axis} data-table-selection-index={index}
            onPointerDown={event => startSelection(axis, index, event)}
            onLostPointerCapture={event => {
              if (event.pointerId === selectionDragRef.current?.pointerId) finishSelection();
            }}
            onMouseDown={event => event.preventDefault()}
            onClick={event => {
              event.preventDefault();
              if (event.detail === 0) select(axis, index, event.shiftKey);
            }}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                select(axis, index, event.shiftKey);
              }
            }}
            onContextMenu={event => openMenu(axis, index, event)}>
            {active && countIndex === index
              ? <span className="table-selection-handle-count" aria-hidden="true" title={`已选 ${count} ${label}`}>{count}</span>
              : <span className="table-selection-handle-mark" aria-hidden="true" />}
          </button>
          {canMove && <button type="button" draggable className={`table-selection-handle-grip is-${axis}`}
            style={gripStyle} aria-label={`拖动第 ${index + 1} ${label}`} tabIndex={-1}
            title={`拖动移动第 ${index + 1} ${label}；也可在右键菜单中移动`}
            data-table-selection-axis={axis} data-table-selection-index={index}
            onPointerDown={event => event.stopPropagation()}
            onMouseDown={event => event.stopPropagation()}
            onClick={event => event.preventDefault()}
            onDragStart={event => startMove(axis, index, event)}
            onContextMenu={event => openMenu(axis, index, event)}>
            {isColumn ? <IconDragDot /> : <IconDragDotVertical />}
          </button>}
        </div>;
      })}
    </div>;
  };

  let dropStyle: CSSProperties | undefined;
  if (drop) {
    dropStyle = drop.axis === 'row'
      ? {left: layout.visible.left, top: clamp(drop.edge, layout.visible.top, layout.visible.bottom) - 1, width: layout.visible.right - layout.visible.left, height: 2}
      : {left: clamp(drop.edge, layout.visible.left, layout.visible.right) - 1, top: layout.visible.top, width: 2, height: layout.visible.bottom - layout.visible.top};
  }
  return createPortal(
    <div ref={rootRef} className="table-selection-handles" data-table-controls="handles" data-table-key={context.tableKey}
      contentEditable={false} role="group" aria-label="表格边缘操作">
      {renderRail('column')}
      {renderRail('row')}
      {layout.showColumns && layout.showRows && <button type="button"
        className={`table-selection-all${allSelected ? ' is-active' : ''}`}
        style={{left: layout.railLeft, top: layout.railTop, width: RAIL_SIZE, height: RAIL_SIZE}}
        aria-label="选中整个表格" aria-pressed={allSelected} title="选中整个表格"
        onMouseDown={event => event.preventDefault()} onClick={() => onSelect('table', 0, 0)}>
        <svg viewBox="0 0 12 12" width="8" height="8" fill="currentColor" aria-hidden="true">
          <path d="M1 1h4v4H1zm6 0h4v4H7zM1 7h4v4H1zm6 0h4v4H7z" />
        </svg>
      </button>}
      {drop && <div className={`table-selection-drop-line is-${drop.axis}`} style={dropStyle} aria-hidden="true" />}
      <span className="table-selection-screen-reader" role="status" aria-live="polite" aria-atomic="true">
        {allSelected ? `已选整个表格，${context.rows} 行 ${context.columns} 列` : fullRows ? `已选 ${rowCount} 行` : fullColumns ? `已选 ${columnCount} 列` : ''}
      </span>
    </div>,
    layout.ownerDocument.body,
  );
}

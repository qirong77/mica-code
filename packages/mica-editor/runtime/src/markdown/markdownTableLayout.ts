import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {$isTableCellNode, $isTableRowNode, getTableElement, TableNode} from '@lexical/table';
import {$nodesOfType, HISTORIC_TAG, type LexicalEditor, mergeRegister, type NodeKey, SKIP_DOM_SELECTION_TAG, SKIP_SCROLL_INTO_VIEW_TAG} from 'lexical';
import {useEffect} from 'react';

export const MARKDOWN_TABLE_MIN_COLUMN_WIDTH = 64;
export const MARKDOWN_TABLE_MIN_ROW_HEIGHT = 28;
export const MARKDOWN_TABLE_LAYOUT_TAG = 'mica-markdown-table-layout';
const MAX_PREFERRED_COLUMN_WIDTH = 360;
const CELL_HORIZONTAL_INSETS = 24;

/** A bounded estimate is enough for a starting width; actual text still wraps. */
function preferredCellWidth(text: string): number {
  let width = CELL_HORIZONTAL_INSETS;
  for (const character of text) {
    width += /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff01-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u.test(character) ? 14 : 7;
    if (width >= MAX_PREFERRED_COLUMN_WIDTH) return MAX_PREFERRED_COLUMN_WIDTH;
  }
  return Math.max(MARKDOWN_TABLE_MIN_COLUMN_WIDTH, width);
}

/**
 * Short tables stay compact. When a table needs more room, divide the available
 * width by its content needs rather than giving an ID column as much as prose.
 * At very narrow widths retain readable columns and let the table wrapper scroll.
 */
export function calculateMarkdownTableColumnWidths(
  rows: readonly (readonly string[])[],
  availableWidth: number,
): number[] {
  const columns = rows.reduce((count, row) => Math.max(count, row.length), 0);
  if (!columns) return [];
  const preferred = Array<number>(columns).fill(MARKDOWN_TABLE_MIN_COLUMN_WIDTH);
  for (const row of rows) {
    for (let column = 0; column < row.length; column++) {
      preferred[column] = Math.max(preferred[column], preferredCellWidth(row[column]));
    }
  }
  const preferredTotal = preferred.reduce((sum, width) => sum + width, 0);
  // Leave one pixel for collapsed outer borders, avoiding a needless scrollbar.
  const budget = Number.isFinite(availableWidth) && availableWidth > 0
    ? Math.max(columns * MARKDOWN_TABLE_MIN_COLUMN_WIDTH, Math.floor(availableWidth) - 1)
    : preferredTotal;
  if (preferredTotal <= budget) return preferred;
  const minimumTotal = columns * MARKDOWN_TABLE_MIN_COLUMN_WIDTH;
  const scale = (budget - minimumTotal) / (preferredTotal - minimumTotal);
  const widths = preferred.map(width => MARKDOWN_TABLE_MIN_COLUMN_WIDTH + Math.floor((width - MARKDOWN_TABLE_MIN_COLUMN_WIDTH) * scale));
  let remainder = budget - widths.reduce((sum, width) => sum + width, 0);
  for (let column = 0; remainder > 0; column = (column + 1) % columns) {
    if (widths[column] < preferred[column]) {
      widths[column]++;
      remainder--;
    }
  }
  return widths;
}

function sameWidths(left: readonly number[] | undefined, right: readonly number[]): boolean {
  return !!left && left.length === right.length && left.every((width, index) => width === right[index]);
}

function contentWidth(element: HTMLElement): number {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return element.clientWidth - (parseFloat(style?.paddingLeft || '') || 0) - (parseFloat(style?.paddingRight || '') || 0);
}

/**
 * Widths live only in the runtime TableNode/DOM. MARKDOWN_TABLE's exporter emits
 * ordinary GFM and intentionally ignores them. Observe the editor, not the window,
 * so opening a side pane also refits tables that the user has not resized.
 */
export function registerMarkdownTableLayout(editor: LexicalEditor): () => void {
  const automatic = new Map<NodeKey, {widths: readonly number[]; available: number}>();
  const styledTables = new Map<HTMLTableElement, {original: string; applied: string}>();
  let root: HTMLElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let cancelFrame: (() => void) | null = null;

  const layout = () => {
    if (!root?.isConnected || contentWidth(root) <= 0) return;
    editor.update(() => {
      const tables = $nodesOfType(TableNode);
      const attached = new Set(tables.map(table => table.getKey()));
      for (const key of automatic.keys()) if (!attached.has(key)) automatic.delete(key);
      for (const table of tables) {
        const element = getTableElement(table, editor.getElementByKey(table.getKey()));
        if (!element?.isConnected || !root) continue;
        const available = Math.min(contentWidth(root), element.parentElement ? contentWidth(element.parentElement) : Infinity);
        if (available <= 0) continue; // Hidden source/visual tabs have no usable viewport.
        const key = table.getKey();
        let widths = table.getColWidths();
        const previous = automatic.get(key);
        if (widths && previous && !sameWidths(widths, previous.widths)) automatic.delete(key);
        if (!widths || (previous && sameWidths(widths, previous.widths) && Math.abs(previous.available - available) >= 1)) {
          const rows = table.getChildren().filter($isTableRowNode).slice(0, 200).map(row => row.getChildren().filter($isTableCellNode).map(cell => cell.getTextContent()));
          const nextWidths = calculateMarkdownTableColumnWidths(rows, available);
          if (nextWidths.length !== table.getColumnCount()) continue;
          if (!sameWidths(widths, nextWidths)) table.setColWidths(nextWidths);
          widths = nextWidths;
          automatic.set(key, {available, widths});
        }
        if (!widths?.length) continue;
        // Fixed table layout needs an explicit table width; otherwise long URLs
        // can still enlarge columns despite their colgroup. This is a DOM-only
        // style, deliberately absent from Markdown and the table's node style.
        const width = `${widths.reduce((sum, value) => sum + value, 0) + 1}px`;
        const saved = styledTables.get(element);
        styledTables.set(element, {original: saved?.original ?? element.style.width, applied: width});
        if (element.style.width !== width) element.style.width = width;
      }
      for (const element of styledTables.keys()) if (!element.isConnected) styledTables.delete(element);
    }, {tag: [HISTORIC_TAG, MARKDOWN_TABLE_LAYOUT_TAG, SKIP_DOM_SELECTION_TAG, SKIP_SCROLL_INTO_VIEW_TAG]});
  };

  const schedule = () => {
    if (cancelFrame || !root?.ownerDocument.defaultView) return;
    const win = root.ownerDocument.defaultView;
    const frame = win.requestAnimationFrame(() => {cancelFrame = null; layout();});
    cancelFrame = () => win.cancelAnimationFrame(frame);
  };

  const unregister = mergeRegister(
    editor.registerRootListener(nextRoot => {
      resizeObserver?.disconnect();
      cancelFrame?.();
      cancelFrame = null;
      root = nextRoot;
      if (root) {
        const Observer = root.ownerDocument.defaultView?.ResizeObserver;
        if (Observer) {resizeObserver = new Observer(schedule); resizeObserver.observe(root);}
        schedule();
      }
    }),
    editor.registerMutationListener(TableNode, schedule),
  );
  return () => {
    unregister();
    resizeObserver?.disconnect();
    cancelFrame?.();
    for (const [element, saved] of styledTables) {
      if (element.style.width === saved.applied) element.style.width = saved.original;
    }
  };
}

export default function MarkdownTableLayoutPlugin(): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => registerMarkdownTableLayout(editor), [editor]);
  return null;
}

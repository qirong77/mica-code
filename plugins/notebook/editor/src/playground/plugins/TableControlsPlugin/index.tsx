import {Button, Tooltip} from '@arco-design/web-react';
import {IconAlignCenter, IconAlignLeft, IconAlignRight, IconApps, IconDown, IconMore, IconPlus} from '@arco-design/web-react/icon';
import {autoUpdate, flip, hide, offset, shift, useFloating} from '@floating-ui/react';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useLexicalEditable} from '@lexical/react/useLexicalEditable';
import {
  $computeTableMap, $createTableSelectionFrom, $getTableCellNodeFromLexicalNode,
  $getTableNodeFromLexicalNodeOrThrow,
  $isTableCellNode, $isTableNode,
  $isTableSelection, $moveTableColumn, $moveTableRow, getTableElement,
} from '@lexical/table';
import {
  $getNearestNodeFromDOMNode, $getNodeByKey, $getSelection, $isRangeSelection,
  $setSelection, type BaseSelection, COMMAND_PRIORITY_LOW, HISTORY_PUSH_TAG,
  HISTORY_MERGE_TAG, mergeRegister, SELECTION_CHANGE_COMMAND, SKIP_DOM_SELECTION_TAG, SKIP_SCROLL_INTO_VIEW_TAG,
} from 'lexical';
import {type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';

import ColorPicker from '../../ui/ColorPicker';
import {$applyTableAction, $readTableContext, registerTableCellPresentation, type TableContext} from './tableActions';
import TableOperationsMenu, {type TableMenuKind} from './TableOperationsMenu';
import TableSelectionHandles from './TableSelectionHandles';

import './index.css';

type PopupKind = TableMenuKind | 'format';
type Popup = {kind: PopupKind; x: number; y: number; anchor?: HTMLElement; anchorOffset?: {x: number; y: number}; keyboard: boolean};
const TABLE_COLORS = ['#ffffff', '#f2f3f5', '#e8f3ff', '#e8ffea', '#fff7e8', '#ffece8', '#f5e8ff', '#165dff', '#00b42a', '#ff7d00', '#f53f3f', '#86909c'];

export default function TableControlsPlugin() {
  const [editor] = useLexicalComposerContext();
  const editable = useLexicalEditable();
  const [context, setContext] = useState<TableContext | null>(null);
  const [popup, setPopup] = useState<Popup | null>(null);
  const [colorReset, setColorReset] = useState(0);
  const popupRef = useRef(popup);
  popupRef.current = popup;
  const contextRef = useRef(context);
  contextRef.current = context;
  const selectionRef = useRef<BaseSelection | null>(null);
  const rightSelectionRef = useRef<BaseSelection | null>(null);
  const toolbar = useFloating({
    placement: 'top-start', strategy: 'fixed',
    middleware: [offset(30), flip({padding: 12}), shift({padding: 12}), hide()],
    whileElementsMounted: autoUpdate,
  });
  const menu = useFloating({
    placement: 'bottom-start', strategy: 'fixed',
    middleware: [offset(6), flip({padding: 12}), shift({padding: 12})],
    whileElementsMounted: autoUpdate,
  });

  const sync = useCallback(() => {
    const next = $readTableContext();
    // Focusing a color input must not lose the saved table selection.
    if (!next && popupRef.current) {
      const table = contextRef.current && $getNodeByKey(contextRef.current.tableKey);
      if (table?.isAttached()) return;
    }
    if (next) selectionRef.current = $getSelection()?.clone() ?? null;
    else {selectionRef.current = null; setPopup(null);}
    setContext(previous => previous && next && Object.keys(next).every(key => previous[key as keyof TableContext] === next[key as keyof TableContext]) ? previous : next);
  }, []);

  useEffect(() => mergeRegister(
    editor.registerUpdateListener(({editorState}) => editorState.read(sync)),
    editor.registerCommand(SELECTION_CHANGE_COMMAND, () => {sync(); return false;}, COMMAND_PRIORITY_LOW),
    registerTableCellPresentation(editor),
  ), [editor, sync]);

  useLayoutEffect(() => {
    if (!context || !editable) return;
    editor.getEditorState().read(() => {
      const table = $getNodeByKey(context.tableKey);
      toolbar.refs.setReference($isTableNode(table) ? getTableElement(table, editor.getElementByKey(table.getKey())) : null);
    });
  }, [context?.tableKey, editable, editor, toolbar.refs]);

  useLayoutEffect(() => {
    if (!popup) return;
    const anchor = popup.anchor;
    const anchorOffset = popup.anchorOffset;
    menu.refs.setPositionReference(anchor && anchorOffset ? {
      contextElement: anchor,
      getBoundingClientRect: () => {
        const rect = anchor.getBoundingClientRect();
        return new DOMRect(rect.left + anchorOffset.x, rect.top + anchorOffset.y, 0, 0);
      },
    } : anchor || {
      getBoundingClientRect: () => new DOMRect(popup.x, popup.y, 0, 0),
    });
    if (popup.keyboard) menu.refs.floating.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"]), .arco-menu-pop-header, button')?.focus();
  }, [popup, menu.refs]);

  useEffect(() => {
    if (editable) return;
    setPopup(null);
    setContext(null);
    selectionRef.current = null;
  }, [editable]);

  useEffect(() => {
    const root = editor.getRootElement();
    const doc = root?.ownerDocument || document;
    const hideOutside = (event: PointerEvent) => {
      const path = event.composedPath();
      if (path.some(item => item instanceof HTMLElement && item.closest('.table-context-toolbar, .table-control-popup, .table-selection-handles, .table-operations-submenu'))) return;
      popupRef.current = null;
      setPopup(null);
      if (!root || !path.some(item => item instanceof Node && root.contains(item))) setContext(null);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || !popupRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      popupRef.current = null;
      setPopup(null);
      editor.update(() => {
        const saved = selectionRef.current;
        if (saved && ($isRangeSelection(saved) || $isTableSelection(saved)) && $getNodeByKey(saved.anchor.key)?.isAttached() && $getNodeByKey(saved.focus.key)?.isAttached()) $setSelection(saved.clone());
      });
      editor.focus();
    };
    const scrolled = (event: Event) => {
      if (popupRef.current && !popupRef.current.anchor && !(event.target instanceof Element && event.target.closest('.table-control-popup, .arco-trigger-popup'))) setPopup(null);
    };
    doc.addEventListener('pointerdown', hideOutside);
    doc.addEventListener('keydown', escape, true);
    doc.addEventListener('scroll', scrolled, true);
    return () => {
      doc.removeEventListener('pointerdown', hideOutside);
      doc.removeEventListener('keydown', escape, true);
      doc.removeEventListener('scroll', scrolled, true);
    };
  }, [editor]);

  useEffect(() => editor.registerRootListener(root => {
    if (!root) return;
    const rememberRightSelection = (event: PointerEvent) => {
      rightSelectionRef.current = null;
      if (event.button === 2) editor.getEditorState().read(() => {
        const selection = $getSelection();
        if ($isTableSelection(selection)) rightSelectionRef.current = selection.clone();
      });
    };
    const showContextMenu = (event: globalThis.MouseEvent) => {
      if (!editor.isEditable()) return;
      const target = event.composedPath()[0];
      if (!(target instanceof Node)) return;
      let handled = false;
      let anchor: HTMLElement | null = null;
      editor.update(() => {
        const node = $getNearestNodeFromDOMNode(target);
        const cell = node ? $getTableCellNodeFromLexicalNode(node) : null;
        if (!cell) return;
        anchor = editor.getElementByKey(cell.getKey());
        const snapshot = rightSelectionRef.current ?? $getSelection();
        const saved = snapshot && ($isRangeSelection(snapshot) || $isTableSelection(snapshot)) && $getNodeByKey(snapshot.anchor.key)?.isAttached() && $getNodeByKey(snapshot.focus.key)?.isAttached() ? snapshot : null;
        const isSelected = saved && ($isRangeSelection(saved) || $isTableSelection(saved)) &&
          ($isTableSelection(saved) ? saved.tableKey === $getTableNodeFromLexicalNodeOrThrow(cell).getKey() && saved.getNodes().some(node => node.is(cell)) : $getTableCellNodeFromLexicalNode(saved.anchor.getNode())?.is(cell));
        if (isSelected) $setSelection(saved.clone());
        else cell.selectStart();
        rightSelectionRef.current = null;
        sync();
        handled = true;
      }, {discrete: true, tag: SKIP_SCROLL_INTO_VIEW_TAG});
      if (handled) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const element = anchor as HTMLElement | null;
        const rect = element?.getBoundingClientRect();
        setPopup({kind: 'context', x: event.clientX, y: event.clientY, anchor: element || undefined,
          anchorOffset: rect ? {x: Math.max(0, event.clientX - rect.left), y: Math.max(0, event.clientY - rect.top)} : undefined,
          keyboard: event.detail === 0 && event.clientX === 0});
      }
    };
    const keyboardContextMenu = (event: globalThis.KeyboardEvent) => {
      if (!editor.isEditable() || !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) return;
      let element: HTMLElement | null = null;
      editor.getEditorState().read(() => {
        const current = $readTableContext();
        if (current) element = editor.getElementByKey(current.cellKey);
      });
      const target = element as HTMLElement | null;
      if (!target) return;
      event.preventDefault();
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(new globalThis.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: rect.left + 16, clientY: rect.top + 18}));
      setPopup(previous => previous && {...previous, keyboard: true});
    };
    root.addEventListener('pointerdown', rememberRightSelection, true);
    root.addEventListener('contextmenu', showContextMenu, true);
    root.addEventListener('keydown', keyboardContextMenu, true);
    return () => {
      root.removeEventListener('pointerdown', rememberRightSelection, true);
      root.removeEventListener('contextmenu', showContextMenu, true);
      root.removeEventListener('keydown', keyboardContextMenu, true);
    };
  }), [editor, sync]);

  const act = useCallback((action: string, keepOpen = false, mergeHistory = false) => {
    const current = contextRef.current;
    if (!current || !editor.isEditable()) return;
    editor.update(() => {
      const table = $getNodeByKey(current.tableKey);
      const cell = $getNodeByKey(current.cellKey);
      if (!$isTableNode(table) || !$isTableCellNode(cell) || !table.isAttached() || !cell.isAttached()) return;
      const saved = selectionRef.current;
      if (saved && ($isTableSelection(saved) || $isRangeSelection(saved)) && $getNodeByKey(saved.anchor.key)?.isAttached() && $getNodeByKey(saved.focus.key)?.isAttached()) $setSelection(saved.clone());
      else cell.selectStart();
      const latest = $readTableContext();
      if (latest && latest.tableKey === current.tableKey) $applyTableAction(action, latest, editor);
      sync();
    }, {tag: keepOpen ? [mergeHistory ? HISTORY_MERGE_TAG : HISTORY_PUSH_TAG, SKIP_DOM_SELECTION_TAG] : HISTORY_PUSH_TAG});
    if (!keepOpen) {popupRef.current = null; setPopup(null);}
  }, [editor, sync]);

  const select = useCallback((axis: 'row' | 'column' | 'table', start: number, end: number) => {
    const current = contextRef.current;
    if (!current || !editor.isEditable()) return;
    editor.update(() => {
      const table = $getNodeByKey(current.tableKey);
      const cell = $getNodeByKey(current.cellKey);
      if (!$isTableNode(table) || !$isTableCellNode(cell) || !table.isAttached() || !cell.isAttached()) return;
      const [map] = $computeTableMap(table, cell, cell);
      const min = Math.max(0, Math.min(start, end));
      const max = Math.max(start, end);
      const first = axis === 'column' ? map[0]?.[min]?.cell : map[axis === 'table' ? 0 : min]?.[0]?.cell;
      const last = axis === 'row' ? map[Math.min(max, map.length - 1)]?.at(-1)?.cell : map.at(-1)?.[axis === 'table' ? map[0].length - 1 : Math.min(max, map[0].length - 1)]?.cell;
      if (first && last) $setSelection($createTableSelectionFrom(table, first, last));
      sync();
    });
  }, [editor, sync]);

  const move = useCallback((axis: 'row' | 'column', from: number, to: number) => {
    const current = contextRef.current;
    if (!current?.simple || !editor.isEditable()) return;
    editor.update(() => {
      const table = $getNodeByKey(current.tableKey);
      if (!$isTableNode(table) || !table.isAttached()) return;
      const count = axis === 'row' ? current.rows : current.columns;
      if (from < 0 || to < 0 || from >= count || to >= count) return;
      if (axis === 'row') $moveTableRow(table, from, to);
      else $moveTableColumn(table, from, to);
      sync();
    }, {tag: HISTORY_PUSH_TAG});
    setPopup(null);
  }, [editor, sync]);

  const openPopup = (kind: PopupKind, event: Event) => {
    const anchor = event.currentTarget;
    if (!(anchor instanceof HTMLElement)) return;
    const rect = anchor.getBoundingClientRect();
    setPopup(previous => previous?.kind === kind && previous.anchor === anchor ? null : {kind, anchor, x: rect.left, y: rect.bottom, keyboard: (event as Event & {detail?: number}).detail === 0});
  };

  const popupKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {setPopup(null); return;}
    const doc = event.currentTarget.ownerDocument;
    const active = doc.activeElement as HTMLElement | null;
    const activeMenu = active?.closest<HTMLElement>('[role="menu"]');
    const header = active?.matches('.arco-menu-pop-header') ? active : null;
    if (header && ['ArrowRight', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      if (event.key !== 'ArrowRight') header.dispatchEvent(new globalThis.KeyboardEvent('keydown', {key: 'ArrowRight', keyCode: 39, bubbles: true}));
      let attempts = 0;
      const focusSubmenu = () => {
        const submenu = doc.getElementById(header.getAttribute('aria-controls') || '');
        const first = submenu?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])');
        if (first) first.focus();
        else if (header.isConnected && ++attempts < 12) doc.defaultView?.requestAnimationFrame(focusSubmenu);
      };
      doc.defaultView?.requestAnimationFrame(focusSubmenu);
      return;
    }
    if (event.key === 'ArrowLeft' && activeMenu?.id) {
      const owner = Array.from(doc.querySelectorAll<HTMLElement>('.table-operations-menu [aria-controls]')).find(item => item.getAttribute('aria-controls') === activeMenu.id);
      if (owner) {
        event.preventDefault();
        owner.dispatchEvent(new globalThis.KeyboardEvent('keydown', {key: 'ArrowLeft', keyCode: 37, bubbles: true}));
        owner.focus();
        return;
      }
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(event.key)) return;
    const scope = activeMenu || event.currentTarget;
    const items = Array.from(scope.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"]):not(.arco-disabled), .arco-menu-pop-header'))
      .filter(item => !activeMenu || item.closest('[role="menu"]') === activeMenu);
    if (!items.length) return;
    const index = items.indexOf(active as HTMLElement);
    if (event.key === ' ') {
      if (index >= 0) {event.preventDefault(); items[index].click();}
      return;
    }
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    items[next]?.focus();
  };

  if (!editable || !context) return null;
  const portalTarget = editor.getRootElement()?.ownerDocument.body || document.body;
  const chosen = context.selected > 1;
  const help = chosen ? `已选 ${context.selectionRows} 行 × ${context.selectionColumns} 列` : `${context.rows} 行 × ${context.columns} 列`;
  const menuButton = (kind: TableMenuKind, label: string) => <Button type="text" size="small" icon={kind === 'more' ? <IconMore /> : <IconDown />}
    aria-label={label} aria-haspopup="menu" aria-expanded={popup?.kind === kind} onClick={event => openPopup(kind, event)} />;

  return <>
    <TableSelectionHandles context={context} onSelect={select} onMove={move}
      onMenu={(axis, index, event) => {
        const fullAxisSelected = axis === 'row' ? context.minColumn === 0 && context.maxColumn === context.columns - 1 && index >= context.minRow && index <= context.maxRow : context.minRow === 0 && context.maxRow === context.rows - 1 && index >= context.minColumn && index <= context.maxColumn;
        if (!fullAxisSelected) select(axis, index, index);
        setPopup({kind: axis, x: event.clientX, y: event.clientY, keyboard: false});
      }} />
    {createPortal(<>
      <div ref={toolbar.refs.setFloating} style={{...toolbar.floatingStyles, visibility: toolbar.middlewareData.hide?.referenceHidden ? 'hidden' : undefined}} className="table-context-toolbar" role="toolbar" aria-label="表格工具栏"
        onMouseDown={event => event.preventDefault()}>
        <Tooltip content={`${help} · 点击选中整个表格`}><button type="button" className={`table-context-label${chosen ? ' has-selection' : ''}`} onClick={() => act('select-table')} aria-label="选中整个表格"><IconApps /><span>{help}</span></button></Tooltip>
        <span className="table-context-divider" />
        <div className="table-context-split-button">
          <Tooltip content={context.selectionRows > 1 ? `在选区下方添加 ${context.selectionRows} 行` : '在当前行下方添加一行'}><Button type="text" size="small" icon={<IconPlus />} onClick={() => act('row-after')}>加行</Button></Tooltip>
          {menuButton('row', '行操作')}
        </div>
        <div className="table-context-split-button">
          <Tooltip content={context.selectionColumns > 1 ? `在选区右侧添加 ${context.selectionColumns} 列` : '在当前列右侧添加一列'}><Button type="text" size="small" icon={<IconPlus />} onClick={() => act('column-after')}>加列</Button></Tooltip>
          {menuButton('column', '列操作')}
        </div>
        <span className="table-context-divider" />
        <Tooltip content={context.merge ? `合并选中的 ${context.selected} 个单元格` : '拖选多个单元格后合并'}><Button type="text" size="small" disabled={!context.merge} onClick={() => act('merge')}>合并</Button></Tooltip>
        <Tooltip content="拆分合并的单元格"><Button type="text" size="small" disabled={!context.split} onClick={() => act('split')}>拆分</Button></Tooltip>
        <span className="table-context-divider" />
        <Tooltip content="为选中单元格设置底色和对齐"><Button type="text" size="small" className="table-format-button" aria-label="单元格样式" aria-expanded={popup?.kind === 'format'} onClick={event => openPopup('format', event)}><i className="icon bg-color" /><span className="table-format-label">样式</span></Button></Tooltip>
        {menuButton('more', '更多表格操作')}
      </div>
      {popup && <div ref={menu.refs.setFloating} style={menu.floatingStyles} className={`table-control-popup${popup.kind === 'format' ? ' table-format-popup' : ''}`}
        onKeyDown={popupKeys} onMouseDown={event => {if (!(event.target instanceof HTMLInputElement)) event.preventDefault();}}>
        {popup.kind === 'format' ? <div role="dialog" aria-label="单元格样式">
          <div className="table-format-heading"><strong>单元格样式</strong><span>{context.selected > 1 ? `${context.selected} 个单元格` : '当前单元格'}</span></div>
          <div className="table-format-alignment" role="group" aria-label="水平对齐">
            {([['left', '左对齐', <IconAlignLeft />], ['center', '水平居中', <IconAlignCenter />], ['right', '右对齐', <IconAlignRight />]] as const).map(([value, label, icon]) => <Tooltip key={value} content={label}><Button type="text" size="small" icon={icon} aria-label={label} aria-pressed={context.alignment === value} onClick={() => act(`align:${value}`, true)} /></Tooltip>)}
            <span className="table-context-divider" />
            {([['top', '顶端对齐', 'vertical-top'], ['middle', '垂直居中', 'vertical-middle'], ['bottom', '底端对齐', 'vertical-bottom']] as const).map(([value, label, icon]) => <Tooltip key={value} content={label}><Button type="text" size="small" aria-label={label} aria-pressed={context.verticalAlign === value} onClick={() => act(`valign:${value}`, true)}><i className={`icon ${icon}`} /></Button></Tooltip>)}
          </div>
          <div className="table-format-color-heading"><span>{context.background === 'mixed' ? '单元格底色 · 多种颜色' : '单元格底色'}</span><Button type="text" size="mini" onClick={() => {act('background:none', true); setColorReset(value => value + 1);}}>清除底色</Button></div>
          <ColorPicker key={`${context.tableKey}:${colorReset}`} compact palette={TABLE_COLORS} color={context.background && context.background !== 'mixed' ? context.background : '#ffffff'} onChange={(color, mergeHistory) => act(`background:${color}`, true, mergeHistory)} />
        </div> : <>
          <div className="table-menu-caption">{popup.kind === 'row' ? '行操作' : popup.kind === 'column' ? '列操作' : popup.kind === 'more' ? '表格设置' : '表格操作'}<span>{help}</span></div>
          <TableOperationsMenu kind={popup.kind} context={context} onAction={act} />
          {popup.kind === 'context' && <button className="table-menu-style-entry" type="button" onClick={() => setPopup({...popup, kind: 'format'})}><i className="icon bg-color" />单元格样式<span>底色与对齐</span></button>}
        </>}
      </div>}
    </>, portalTarget)}
  </>;
}

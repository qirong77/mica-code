/**
 * Yuque-shaped block menu: one card, 36px rows, 14px labels, grouped by
 * dividers, and three rows that open a submenu to the right.
 *
 * The surface and its keyboard behavior come from the shared action menu
 * (`mica-config-ui/web/components/ActionMenu`); only placement, the submenu
 * stack and the notebook's own actions live here.
 */

import {getComposedEventTarget, registerEventListener} from 'lexical';
import {
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {createPortal} from 'react-dom';

import {MenuItem, MenuList, MenuSeparator} from '../../../../../../mica-config-ui/web/components/ActionMenu';
import type {ComponentPickerOption} from '../ComponentPickerPlugin';
import type {BlockShape} from './blockMenuActions';
import {
  MENU_MIN_WIDTH,
  type PlacementSafeArea,
  type PlacementRect,
  placeBlockMenu,
  placeSubmenu,
} from './blockMenuPlacement';

export type BlockMenuAction =
  | {type: 'shape'; shape: BlockShape}
  | {type: 'delete'}
  | {type: 'copy'}
  | {type: 'cut'}
  | {type: 'indent'; delta: 1 | -1}
  | {type: 'insert'; option: ComponentPickerOption};

type SubmenuKind = 'turn-into' | 'indent' | 'insert-below';

type Rect = PlacementRect;

function notebookSafeArea(): PlacementSafeArea {
  if (!document.querySelector('.notebook-workbench')) return {};
  const rootStyle = getComputedStyle(document.documentElement);
  const parsedBar = Number.parseFloat(rootStyle.getPropertyValue('--notebook-bar-height'));
  const toolbar = document.querySelector<HTMLElement>('.notebook-workbench .toolbar');
  const statusbar = document.querySelector<HTMLElement>('.notebook-workbench .document-statusbar');
  const panel = document.querySelector<HTMLElement>('.notebook-document-panel');
  return {
    top: Number.isFinite(parsedBar) ? parsedBar : toolbar?.getBoundingClientRect().height ?? 0,
    bottom: statusbar?.getBoundingClientRect().height ?? 0,
    right: document.body.dataset.notebookStyle === 'open' ? panel?.getBoundingClientRect().width ?? 0 : 0,
  };
}

const SHAPE_ITEMS: Array<{shape: BlockShape; label: string}> = [
  {shape: 'paragraph', label: '正文'},
  {shape: 'h2', label: '标题 2'},
  {shape: 'h3', label: '标题 3'},
  {shape: 'bullet', label: '无序列表'},
  {shape: 'number', label: '有序列表'},
  {shape: 'quote', label: '引用'},
  {shape: 'code', label: '代码块'},
];

function Chevron(): JSX.Element {
  return <span className="mica-block-menu__chevron" aria-hidden="true" />;
}

function SubMenuPanel({
  row,
  main,
  label,
  children,
  onMouseEnter,
  onMouseLeave,
  onKeyDown,
}: {
  /** The card row the submenu belongs to. */
  row: Rect;
  /** The main card, already measured. */
  main: Rect;
  label: string;
  children: ReactNode;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(() =>
    placeSubmenu({
      row,
      main,
      size: {width: MENU_MIN_WIDTH, height: 0},
      viewport: {width: window.innerWidth, height: window.innerHeight},
      safeArea: notebookSafeArea(),
    }),
  );

  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    const size = panel.getBoundingClientRect();
    const next = placeSubmenu({
      row,
      main,
      size: {width: size.width, height: size.height},
      viewport: {width: window.innerWidth, height: window.innerHeight},
      safeArea: notebookSafeArea(),
    });
    setPosition(current => (current.left === next.left && current.top === next.top ? current : next));
  }, [row.left, row.top, main.left, main.right]);

  return createPortal(
    <MenuList
      className="mica-block-menu is-submenu"
      aria-label={label}
      ref={ref}
      style={{left: position.left, position: 'fixed', top: position.top, zIndex: 1001}}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onKeyDown={onKeyDown}>
      {children}
    </MenuList>,
    document.body,
  );
}

export default function BlockMenu({
  anchor,
  blockRect,
  shape,
  insertOptions,
  onAction,
  onClose,
}: {
  /** The handle the menu hangs from. */
  anchor: Rect;
  /** The block the menu acts on; the card opens under it like Yuque's. */
  blockRect: Rect;
  shape: BlockShape | null;
  insertOptions: ComponentPickerOption[];
  onAction: (action: BlockMenuAction) => void;
  /** `true` when the menu should hand the caret back to its block. */
  onClose: (restoreFocus?: boolean) => void;
}): JSX.Element {
  const mainRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{left: number; top: number}>(() =>
    placeBlockMenu({
      anchor,
      blockRect,
      size: {width: MENU_MIN_WIDTH, height: 0},
      viewport: {width: window.innerWidth, height: window.innerHeight},
      safeArea: notebookSafeArea(),
    }),
  );

  useLayoutEffect(() => {
    const panel = mainRef.current;
    if (!panel) return;
    const size = panel.getBoundingClientRect();
    const next = placeBlockMenu({
      anchor,
      blockRect,
      size: {width: size.width, height: size.height},
      viewport: {width: window.innerWidth, height: window.innerHeight},
      safeArea: notebookSafeArea(),
    });
    setPosition(current => (current.left === next.left && current.top === next.top ? current : next));
  }, [anchor.left, anchor.top, blockRect.top, blockRect.bottom]);

  const [submenu, setSubmenu] = useState<{kind: SubmenuKind; row: Rect} | null>(null);
  // The submenu is a portal sibling, not a child: moving from the card into it
  // fires the card's `mouseleave`. Yuque keeps the stack open, so the close is
  // deferred long enough for the pointer to cross the 4px gap.
  const closeTimer = useRef<number | null>(null);
  const cancelSubmenuClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const scheduleSubmenuClose = useCallback(() => {
    cancelSubmenuClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setSubmenu(null);
    }, 160);
  }, [cancelSubmenuClose]);

  useEffect(() => {
    const panel = mainRef.current;
    if (!panel) return;
    const doc = panel.ownerDocument;
    const submenuNode = () => doc.querySelector('.mica-block-menu.is-submenu');
    const isInside = (target: Node | null) =>
      Boolean(
        target &&
          (panel.contains(target) ||
            submenuNode()?.contains(target) ||
            (target as HTMLElement).closest?.('.draggable-block-menu')),
      );

    const stopOutside = registerEventListener(doc, 'pointerdown', event => {
      const target = getComposedEventTarget(event) as Node | null;
      if (!isInside(target)) onClose(false);
    }, true);
    const stopScroll = registerEventListener(doc, 'scroll', event => {
      const target = getComposedEventTarget(event) as Node | null;
      // Scrolling a long submenu must not dismiss the menu stack. Only a
      // scroll outside both portalled panels means the editor moved away.
      if (target && (panel.contains(target) || submenuNode()?.contains(target))) return;
      onClose(false);
    }, true);
    const stopResize = registerEventListener(window, 'resize', () => onClose(false));
    const stopBlur = registerEventListener(window, 'blur', () => onClose(false));
    const stopKey = registerEventListener(window, 'keydown', event => {
      if (event.key === 'Escape') onClose(true);
    });
    return () => {
      stopOutside();
      stopScroll();
      stopResize();
      stopBlur();
      stopKey();
    };
  }, [onClose]);

  const openSubmenu = useCallback((kind: SubmenuKind, row: HTMLElement) => {
    setSubmenu({kind, row: row.getBoundingClientRect()});
  }, []);

  const closeSubmenu = useCallback(() => setSubmenu(null), []);

  useEffect(() => () => cancelSubmenuClose(), [cancelSubmenuClose]);

  const submenuFor = (kind: SubmenuKind): ReactNode => {
    if (!submenu || submenu.kind !== kind) return null;
    if (kind === 'turn-into') {
      return SHAPE_ITEMS.map(item => (
        <MenuItem
          key={item.shape}
          className="mica-block-menu__item"
          data-block-action={`turn-${item.shape}`}
          selected={shape === item.shape}
          onClick={() => onAction({type: 'shape', shape: item.shape})}>
          {item.label}
        </MenuItem>
      ));
    }
    if (kind === 'indent') {
      return [
        <MenuItem
          key="indent-in"
          className="mica-block-menu__item"
          data-block-action="indent-in"
          onClick={() => onAction({type: 'indent', delta: 1})}>
          增加缩进
        </MenuItem>,
        <MenuItem
          key="indent-out"
          className="mica-block-menu__item"
          data-block-action="indent-out"
          onClick={() => onAction({type: 'indent', delta: -1})}>
          减少缩进
        </MenuItem>,
      ];
    }
    return insertOptions.map(option => (
      <MenuItem
        key={option.key}
        className="mica-block-menu__item"
        data-block-insert={option.key}
        icon={option.icon}
        onClick={() => onAction({type: 'insert', option})}>
        {option.title.split(' ')[0]}
      </MenuItem>
    ));
  };

  const submenuRow = (kind: SubmenuKind, label: string, icon: JSX.Element): JSX.Element => (
    <MenuItem
      className="mica-block-menu__item"
      data-block-action={kind}
      aria-haspopup="menu"
      aria-expanded={submenu?.kind === kind || undefined}
      icon={icon}
      onMouseEnter={event => openSubmenu(kind, event.currentTarget)}
      onClick={event => openSubmenu(kind, event.currentTarget)}>
      {label}
      <Chevron />
    </MenuItem>
  );

  return createPortal(
    <>
      <MenuList
        className="mica-block-menu"
        aria-label="块操作"
        ref={mainRef}
        autoFocus
        style={{left: position.left, position: 'fixed', top: position.top, zIndex: 1000}}
        onClose={() => onClose(true)}
        onKeyDown={event => {
          if (event.key === 'ArrowRight') {
            const row = (event.target as HTMLElement).closest<HTMLElement>('[aria-haspopup="menu"]');
            const kind = row?.dataset.blockAction as SubmenuKind | undefined;
            if (!row || !kind) return;
            event.preventDefault();
            openSubmenu(kind, row);
            window.setTimeout(() => {
              document
                .querySelector<HTMLElement>('.mica-block-menu.is-submenu [role="menuitem"]:not([aria-disabled="true"])')
                ?.focus({preventScroll: true});
            }, 0);
          }
          if (event.key === 'ArrowLeft') {
            const inSubmenu = (event.target as HTMLElement).closest('.mica-block-menu.is-submenu');
            if (!inSubmenu) return;
            event.preventDefault();
            const kind = submenu?.kind;
            setSubmenu(null);
            if (kind) mainRef.current?.querySelector<HTMLElement>(`[data-block-action="${kind}"]`)?.focus();
          }
        }}
        onMouseEnter={cancelSubmenuClose}
        onMouseLeave={scheduleSubmenuClose}>
        {submenuRow('turn-into', '转化为', <i className="mica-block-menu__glyph is-turn-into" />)}
        <MenuSeparator />
        <MenuItem
          className="mica-block-menu__item"
          data-block-action="delete"
          icon={<i className="mica-block-menu__glyph is-delete" />}
          onMouseEnter={closeSubmenu}
          onClick={() => onAction({type: 'delete'})}>
          删除
        </MenuItem>
        <MenuItem
          className="mica-block-menu__item"
          data-block-action="copy"
          icon={<i className="mica-block-menu__glyph is-copy" />}
          onMouseEnter={closeSubmenu}
          onClick={() => onAction({type: 'copy'})}>
          复制
        </MenuItem>
        <MenuItem
          className="mica-block-menu__item"
          data-block-action="cut"
          icon={<i className="mica-block-menu__glyph is-cut" />}
          onMouseEnter={closeSubmenu}
          onClick={() => onAction({type: 'cut'})}>
          剪切
        </MenuItem>
        <MenuSeparator />
        {submenuRow('indent', '缩进', <i className="mica-block-menu__glyph is-indent" />)}
        <MenuSeparator />
        {submenuRow('insert-below', '在下方添加', <i className="mica-block-menu__glyph is-insert" />)}
      </MenuList>
      {submenu ? (
        <SubMenuPanel
          label={submenu.kind === 'turn-into' ? '转化为' : submenu.kind === 'indent' ? '缩进' : '在下方添加'}
          row={submenu.row}
          main={mainRef.current?.getBoundingClientRect() ?? submenu.row}
          onMouseEnter={cancelSubmenuClose}
          onMouseLeave={scheduleSubmenuClose}
          onKeyDown={event => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              const kind = submenu.kind;
              setSubmenu(null);
              mainRef.current?.querySelector<HTMLElement>(`[data-block-action="${kind}"]`)?.focus();
            }
          }}>
          {submenuFor(submenu.kind)}
        </SubMenuPanel>
      ) : null}
    </>,
    document.body,
  );
}

/** Hover hint the handle shows, matching Yuque's "可拖拽和点击". */
export function BlockHandleHint(): JSX.Element {
  return <span className="mica-block-handle__hint">可拖拽和点击</span>;
}

import React, { cloneElement, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  BookMarked,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  FilePlus2,
  Focus,
  FolderInput,
  FolderPlus,
  ListTree,
  LocateFixed,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import {
  Alert,
  ArcoPopover,
  Button,
  Empty,
  Input,
  MenuItem,
  MenuList,
  MenuSeparator,
  SelectMenu,
} from '@mica-config-ui/web';
import { Modal } from '../../packages/mica-config-ui/web/components/Modal';
import { pluginApiBasePath } from '../../packages/mica-plugin/PluginApi';
import { createNotebookController, NotebookConflictError } from './controller';
import { createNotebookExternalUpdateCheck } from './external-updates';
import { createNotebookPageRefresh } from './web/page-refresh';
import {
  createNode,
  createNodeId,
  emptyIndex,
  flattenVisibleTree,
  moveNode,
  placeNode,
  renameNode,
  restoreNode,
  trashNode,
} from './model';
import { notebookDropPosition, resolveNotebookDrop } from './tree-dnd';
import { createEditorBridge } from './bridge';
import { createNotebookDraft, createNotebookWriter, rememberNotebookDraft, updateNotebookDraft } from './writer';
import { createNotebookLifecycle } from './lifecycle';
import './notebook.css';

const message = (error) =>
  error instanceof NotebookConflictError
    ? '这篇笔记已在其他窗口修改。当前草稿已保留，请先下载草稿备份，再重新打开最新版本。'
    : error instanceof Error
      ? error.message
      : String(error);

const emptyOutline = () => ({
  items: [],
  activeKey: null,
});

function nodesById(index) {
  return new Map(index.nodes.map((node) => [node.id, node]));
}

function nodePath(node, byId) {
  const path = [];
  for (let entry = node; entry; entry = byId.get(entry.parentId)) path.push(entry);
  return path.reverse();
}

/**
 * 目录宽度：桌面上可以拖，窄屏的抽屉保持自己的宽度。
 *
 * 边界由「绝对上下限」和「当前可用区域」一起决定：正文无论如何要留出
 * `RAIL_MIN_MAIN_WIDTH`，目录最多占页面宽度的 `RAIL_MAX_SHARE`，两处取更紧的那个。
 */
export const RAIL_MIN_WIDTH = 200;
export const RAIL_MAX_WIDTH = 460;
export const RAIL_DEFAULT_WIDTH = 260;
const RAIL_MIN_MAIN_WIDTH = 480;
const RAIL_MAX_SHARE = 0.42;
/** 键盘一次挪多少。 */
export const RAIL_KEY_STEP = 16;
/**
 * 宽度存在插件自己的文档里（和正文同一个版本化文档通道，`documents/<key>.json`）。
 * 界面偏好属于插件，不进宿主的 ui-state，也不与索引 CAS 抢同一次写。
 */
// A dot cannot occur in a note id, so preferences can never overwrite a note body.
export const RAIL_LAYOUT_DOCUMENT = 'ui.layout';

/** 同一行的两次点击落在这个窗口内就算「双击改名」（手机双击与桌面双击共用）。 */
export const RENAME_TAP_WINDOW_MS = 320;

/**
 * 编辑器骨架出现前先安静这么久。编辑器是整份从 iframe 里重新跑起来的：CDN 依赖
 * 命中缓存只省掉网络，不省解析与执行，热缓存下一次启动也在 0.3–0.6s。先把这段
 * 留白，别每次打开都甩一整屏加载页。
 */
export const EDITOR_SKELETON_DELAY_MS = 320;

/**
 * 编辑区上方盖什么。
 * - `error`：编辑器起不来，必须明确告知。
 * - `skeleton`：只有「这个 iframe 还没启动过」才值得整屏遮挡；已经起来的 iframe
 *   只是换一篇正文（几十毫秒），盖上去只会闪一下，留着上一篇更好。
 */
export function editorOverlayMode({ frameState, booted, delayElapsed }) {
  if (frameState === 'error') return 'error';
  if (frameState === 'loading' && !booted && delayElapsed) return 'skeleton';
  return null;
}

/**
 * 目录行的点击记账。返回这次点击要不要进入改名，以及下一次点击要比较的基准。
 * 只认同一行、且时间不倒退的两次点击：换行点击或停顿过久都重新开始计数。
 *
 * @param {{ id: string | null, at: number }} previous 上一次点击记下的行与时间
 * @param {string} id 这一行的节点 id
 * @param {number} at 这次点击的时间戳
 * @returns {{ rename: boolean, next: { id: string | null, at: number } }}
 */
export function notebookRowTap(previous, id, at) {
  if (previous.id === id && at >= previous.at && at - previous.at <= RENAME_TAP_WINDOW_MS) {
    return { rename: true, next: { id: null, at: 0 } };
  }
  return { rename: false, next: { id, at } };
}

/** 目录能拖到的区间；没有可用宽度信息时只按绝对边界算。 */
export function notebookRailLimits(available) {
  const width = Number(available);
  const max =
    Number.isFinite(width) && width > 0
      ? Math.min(RAIL_MAX_WIDTH, Math.round(width * RAIL_MAX_SHARE), Math.round(width - RAIL_MIN_MAIN_WIDTH))
      : RAIL_MAX_WIDTH;
  return { min: RAIL_MIN_WIDTH, max: Math.max(RAIL_MIN_WIDTH, max) };
}

/** 归一化一个宽度：非法值（缺失、非数字）回默认宽度，其余夹进边界。 */
export function clampRailWidth(width, available) {
  const value = Number(width);
  const { min, max } = notebookRailLimits(available);
  return Math.min(Math.max(Number.isFinite(value) ? Math.round(value) : RAIL_DEFAULT_WIDTH, min), max);
}

function editorNodeText(value) {
  if (Array.isArray(value)) return value.map(editorNodeText).join('');
  if (!value || typeof value !== 'object') return '';
  const record = value;
  if (typeof record.text === 'string') return record.text;
  return editorNodeText(record.children);
}

/**
 * The first top-level H1 is the file title; the runtime keeps it fixed.
 * Returns null when the document has no title block at all, so an intentionally
 * emptied title reads as `''` instead of looking like a missing title.
 */
function notebookDocumentTitle(document) {
  if (!document?.editorState) return null;
  try {
    const state = JSON.parse(document.editorState);
    const first = state?.root?.children?.[0];
    if (first?.type !== 'heading' || first?.tag !== 'h1') return null;
    return editorNodeText(first.children).replace(/\s+/g, ' ').trim().slice(0, 100);
  } catch {
    return null;
  }
}

/** The index controller may replay this operation after a CAS conflict or uncertain write. */
export function createDefaultNote({ id, now, parentId }) {
  return (latest) =>
    latest.nodes.some((node) => node.id === id)
      ? latest
      : createNode(latest, { id, now, kind: 'note', title: '未命名笔记', parentId });
}

function download(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name.replace(/[/\\:*?"<>|]/g, '-')}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 浮层菜单的一行：图标 + 左对齐文字。删除类动作沿用 danger 的红色。
 */
function MenuRow({ action, label, Icon, variant = 'ghost', onSelect, disabled = false }) {
  return (
    <MenuItem
      danger={variant === 'danger-ghost'}
      icon={<Icon size={16} strokeWidth={1.7} />}
      disabled={disabled}
      onClick={() => onSelect(action)}
    >
      <span className="mica-menu-label">{label}</span>
    </MenuItem>
  );
}

function YuqueIcon({ name, size = 16 }) {
  return (
    <i className="notebook-yuque-icon" data-icon={name} style={{ width: size, height: size }} aria-hidden="true" />
  );
}

/**
 * 笔记的「更多」菜单：重命名 / 移动 / 删除。目录行与顶栏共用。
 *
 * ArcoPopover 负责定位与点外关闭；菜单行、键盘导航与 Esc 交给共享菜单。
 *
 * 默认 `bl`：菜单贴着触发按钮的左边往下展开，也就是「向右下」长出去——目录行的
 * 「更多」本来就在目录右缘，这样菜单落在正文一侧而不是压回目录里。靠窗口右边界时
 * Arco 的 `autoFitPosition` 会把它向左内收，不会跑出视口。
 */
function PopoverMenu({ open, onOpen, onClose, label, position = 'bl', trigger, children, form }) {
  const anchorId = useId();
  return (
    <ArcoPopover
      trigger="click"
      className="mica-menu-popover"
      position={position}
      escToClose
      popupVisible={open}
      onVisibleChange={(visible) => (visible ? onOpen() : onClose())}
      triggerProps={{ showArrow: false }}
      content={
        form || (
          <MenuList
            aria-label={label}
            autoFocus
            onClose={() => {
              onClose();
              document.getElementById(anchorId)?.querySelector('button')?.focus({ preventScroll: true });
            }}
          >
            {children}
          </MenuList>
        )
      }
    >
      {cloneElement(trigger, { id: anchorId })}
    </ArcoPopover>
  );
}

function CreateMenu({ open, onOpen, onClose, onCreate, label, title = label, disabled, tabIndex, toolbar = false }) {
  return (
    <PopoverMenu
      open={open}
      onOpen={onOpen}
      onClose={onClose}
      label={label}
      position="bl"
      trigger={
        <span className={toolbar ? 'notebook-rail-add-anchor' : 'notebook-menu-anchor'}>
          <Button
            variant="ghost"
            className={toolbar ? 'notebook-rail-add' : undefined}
            icon={<Plus size={toolbar ? 16 : 15} strokeWidth={1.7} />}
            aria-label={label}
            title={title}
            aria-haspopup="menu"
            aria-expanded={open}
            pressed={open}
            disabled={disabled}
            tabIndex={tabIndex}
          />
        </span>
      }
    >
      <MenuRow action="note" label="新建笔记" Icon={FilePlus2} onSelect={onCreate} />
      <MenuRow action="folder" label="新建文件夹" Icon={FolderPlus} onSelect={onCreate} />
    </PopoverMenu>
  );
}

function NoteMenu({ node, open, onOpen, onClose, onAction, extraRows, trigger, position = 'bl', form }) {
  return (
    <PopoverMenu
      open={open}
      onOpen={onOpen}
      onClose={onClose}
      label={`${node.title} 的操作`}
      position={position}
      trigger={trigger}
      form={form}
    >
      {extraRows && (
        <>
          {extraRows}
          <MenuSeparator />
        </>
      )}
      <MenuRow action="rename" label="重命名" Icon={Pencil} onSelect={onAction} />
      <MenuRow action="copy" label="复制名称" Icon={Copy} onSelect={onAction} />
      <MenuRow action="move" label="移动到…" Icon={FolderInput} onSelect={onAction} />
      <MenuSeparator />
      <MenuRow action="delete" label="移到最近删除" Icon={Trash2} variant="danger-ghost" onSelect={onAction} />
    </PopoverMenu>
  );
}

export default function NotebookPage({ api }) {
  const [index, setIndex] = useState(emptyIndex);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [activeId, setActiveId] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [expanded, setExpanded] = useState(new Set());
  const [query, setQuery] = useState('');
  const [trash, setTrash] = useState(false);
  const [menu, setMenu] = useState(null);
  const [copyHint, setCopyHint] = useState('');
  const copyHintTimer = useRef(null);
  const [draggingId, setDraggingId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const dragSource = useRef(null);
  const folderHover = useRef(null);
  const lastRowTap = useRef({ id: null, at: 0 });
  const [railOpen, setRailOpen] = useState(() => !window.matchMedia('(max-width: 760px)').matches);
  const [layout, setLayout] = useState(() => ({
    mobile: window.innerWidth <= 760,
  }));
  const [railWidth, setRailWidth] = useState(RAIL_DEFAULT_WIDTH);
  const [railMaxWidth, setRailMaxWidth] = useState(RAIL_MAX_WIDTH);
  const [railDragging, setRailDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(() => !window.matchMedia('(max-width: 1100px)').matches);
  const [outlineCollapsed, setOutlineCollapsed] = useState(new Set());
  const [outline, setOutline] = useState(emptyOutline);
  const [externalUpdate, setExternalUpdate] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [frameState, setFrameState] = useState('loading');
  /** 当前 iframe 是否已经完整启动过一次；换帧（重试、token 变）会重置。 */
  const [frameBooted, setFrameBooted] = useState(false);
  const [skeletonDelayElapsed, setSkeletonDelayElapsed] = useState(false);
  const [editorModalOpen, setEditorModalOpen] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const [apiOpen, setApiOpen] = useState(false);
  const [copied, setCopied] = useState('');
  const iframe = useRef(null);
  const pageRoot = useRef(null);
  const rail = useRef(null);
  // 拖动过程中只写样式变量（正文实时跟着变），松手才落到状态与存储。
  const railWidthRef = useRef(RAIL_DEFAULT_WIDTH);
  const appliedRailWidth = useRef(RAIL_DEFAULT_WIDTH);
  const railResize = useRef(null);
  const railSave = useRef({ timer: null, value: null, saving: null, touched: false });
  const outlineItemRefs = useRef(new Map());
  const barLead = useRef(null);
  const barActions = useRef(null);
  const syncLayout = useRef(() => {});
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const bridge = useRef(null);
  const ready = useRef(false);
  const uncollected = useRef(false);
  const current = useRef(null);
  const drafts = useRef(new Map());
  const saveTimer = useRef(null);
  const titleTimer = useRef(null);
  const pendingTitle = useRef(null);
  // 正文最近一次上报的标题。索引改名如果是正文自己引起的，就不再回灌到编辑器。
  const reportedTitle = useRef('');
  const mounted = useRef(true);
  const loadedNote = useRef(null);
  const tree = useRef(null);
  const actions = useRef({});
  const creating = useRef(false);
  // 深链（`/plugins/pages/notebook?note=<id>`）：首屏要打开的是这一篇，而不是第一篇。
  // 只在挂载时取一次——之后地址由页面自己按当前笔记改写。
  const deepLink = useRef(null);
  if (deepLink.current === null) deepLink.current = api.page?.search?.() ?? {};
  const token = useMemo(() => createNodeId(), [frameKey]);
  const controller = useMemo(() => createNotebookController({ host: api, onIndex: setIndex }), [api]);
  const writer = useMemo(() => createNotebookWriter(controller), [controller]);
  const lifecycle = useMemo(
    () =>
      createNotebookLifecycle({
        freeze: (frozen) => bridge.current?.freeze(frozen),
        canEdit: () => ready.current && loadedNote.current === current.current?.id,
      }),
    [],
  );
  const byId = useMemo(() => nodesById(index), [index]);
  const activeNode = byId.get(activeId);
  const active = activeNode?.trashedAt ? null : activeNode;
  const hasActiveNote = !!active;
  const selected = byId.get(selectedId);
  const overlay = editorOverlayMode({
    frameState,
    booted: frameBooted,
    delayElapsed: skeletonDelayElapsed,
  });
  // API：笔记本跑在 Mica 运行时里，模型与人对准的都是这台机器上的同一个端口。
  // 接口根就是文档端点；`/overview` 是主接口，一次拿全目录、最近删除与端点表。
  const apiBase = `${api.currentHost?.() ?? ''}${pluginApiBasePath('notebook')}`;
  const overviewCurl = `curl ${apiBase}/overview`;
  const copyText = useCallback(async (text, key) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((value) => (value === key ? '' : value)), 1400);
    } catch (cause) {
      setError(message(cause));
    }
  }, []);
  /** 桌面上的整行要能拖动，鼠标拖动会被拖拽接管，所以名字另外给一个「复制名称」。 */
  const copyRowName = useCallback(async (node) => {
    try {
      await navigator.clipboard.writeText(node.title);
      setCopyHint(`已复制「${node.title}」`);
      if (copyHintTimer.current) clearTimeout(copyHintTimer.current);
      copyHintTimer.current = setTimeout(() => setCopyHint(''), 1800);
    } catch (cause) {
      setError(message(cause));
    }
  }, []);
  const directory = useMemo(() => flattenVisibleTree(index), [index]);
  const noteCount = useMemo(() => directory.filter(({ node }) => node.kind === 'note').length, [directory]);
  const listing = useMemo(
    () => (trash ? flattenVisibleTree(index, { showTrash: true }) : directory),
    [directory, index, trash],
  );
  const searchTerm = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (searchTerm) return listing.filter(({ node }) => node.title.toLowerCase().includes(searchTerm));
    if (trash) return listing;
    let foldedDepth = Infinity;
    return listing.filter(({ node, depth }) => {
      if (depth > foldedDepth) return false;
      foldedDepth = node.kind === 'folder' && !expanded.has(node.id) ? depth : Infinity;
      return true;
    });
  }, [listing, expanded, searchTerm, trash]);
  const folders = useMemo(() => directory.filter(({ node }) => node.kind === 'folder'), [directory]);
  const hasExpandedFolder = visible.some(({ node, hasChildren }) => hasChildren && expanded.has(node.id));
  const tabStop = visible.some(({ node }) => node.id === selectedId) ? selectedId : visible[0]?.node.id;
  const dropMarker = useMemo(() => {
    if (!dropTarget || dropTarget.position !== 'after') return dropTarget;
    const start = visible.findIndex(({ node }) => node.id === dropTarget.targetId);
    if (start < 0) return dropTarget;
    let end = start;
    while (end + 1 < visible.length && visible[end + 1].depth > visible[start].depth) end++;
    return { ...dropTarget, targetId: visible[end].node.id, depth: visible[start].depth };
  }, [dropTarget, visible]);
  const canArrange = loaded && !busy && !trash && !query.trim() && !dialog;
  const clearFolderHover = () => {
    if (folderHover.current) clearTimeout(folderHover.current.timer);
    folderHover.current = null;
  };
  const clearDrag = () => {
    clearFolderHover();
    dragSource.current = null;
    setDraggingId(null);
    setDropTarget(null);
  };
  useEffect(() => {
    if (!canArrange) clearDrag();
  }, [canArrange]);
  useEffect(
    () => () => {
      clearFolderHover();
      if (copyHintTimer.current) clearTimeout(copyHintTimer.current);
    },
    [],
  );
  const railOverlay = layout.mobile && railOpen && !focused;
  const outlineAvailable = !focused && !!active;

  /**
   * 把宽度写到页面根节点的样式变量上。
   *
   * 目录宽度是纯 CSS 变量（`.notebook-rail` 的 `width`），所以拖动时只改这一个值，
   * 正文、编辑器 iframe 都跟着布局走，不必为每个像素重画整棵目录树。
   */
  const applyRailWidth = useCallback((width) => {
    const root = pageRoot.current;
    const applied = clampRailWidth(width, root?.clientWidth);
    appliedRailWidth.current = applied;
    root?.style.setProperty('--notebook-rail-width', `${applied}px`);
    return applied;
  }, []);

  /** 落盘当前宽度：读一次最新版本再写，别的窗口先写过就重取版本再写一次。 */
  const flushRailWidth = useCallback(() => {
    const documents = api.documents;
    const pending = railSave.current;
    if (pending.saving) return pending.saving;
    if (pending.value == null || !documents?.read || !documents?.write) return;
    pending.saving = (async () => {
      while (pending.value != null) {
        const width = pending.value;
        pending.value = null;
        try {
          for (let attempt = 0; attempt < 2; attempt++) {
            const stored = await documents.read(RAIL_LAYOUT_DOCUMENT);
            if (stored?.ok === false) break;
            const result = await documents.write(
              RAIL_LAYOUT_DOCUMENT,
              { version: 1, railWidth: width },
              { expectedVersion: stored?.version ?? null },
            );
            if (result?.ok || !result?.conflict) break;
          }
        } catch {
          // Layout failure must not interrupt writing. Newer drags still get saved.
        }
      }
    })().finally(() => {
      pending.saving = null;
    });
    return pending.saving;
  }, [api.documents]);
  const flushRailRef = useRef(flushRailWidth);
  flushRailRef.current = flushRailWidth;

  // 连续按方向键时合并成一次写盘。
  const queueRailWidth = useCallback((width) => {
    const pending = railSave.current;
    pending.value = width;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      pending.timer = null;
      void flushRailRef.current();
    }, 250);
  }, []);

  /** 一次明确的宽度变更（拖动结束、键盘、双击复位）：应用、记状态、排队保存。 */
  const commitRailWidth = useCallback(
    (width) => {
      railSave.current.touched = true;
      const applied = applyRailWidth(width);
      railWidthRef.current = applied;
      setRailWidth(applied);
      queueRailWidth(applied);
    },
    [applyRailWidth, queueRailWidth],
  );

  const startRailResize = (event) => {
    if (railResize.current || layoutRef.current.mobile) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const handle = event.currentTarget;
    if (!pageRoot.current) return;
    event.preventDefault();
    // 点一下也能接着用方向键挪，不必再按一次 Tab。
    handle.focus?.({ preventScroll: true });
    railResize.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: Math.round(rail.current?.offsetWidth || appliedRailWidth.current),
    };
    try {
      handle.setPointerCapture?.(event.pointerId);
    } catch {
      // 指针已经抬起来（例如触屏手势被系统接管）：照旧按跟随指针的方式拖，松手即结束
    }
    pageRoot.current.classList.add('is-resizing');
    railSave.current.touched = true;
    setRailDragging(true);
  };
  const moveRailResize = (event) => {
    const state = railResize.current;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    const width = applyRailWidth(state.startWidth + (event.clientX - state.startX));
    railWidthRef.current = width;
    event.currentTarget.setAttribute('aria-valuenow', String(width));
  };
  const endRailResize = (event) => {
    const state = railResize.current;
    if (!state || (event && state.pointerId !== event.pointerId)) return;
    railResize.current = null;
    const handle = event?.currentTarget;
    try {
      if (handle?.hasPointerCapture?.(state.pointerId)) handle.releasePointerCapture(state.pointerId);
    } catch {
      // 捕获已经被系统收回（窗口失焦等），不必再释放
    }
    pageRoot.current?.classList.remove('is-resizing');
    setRailDragging(false);
    commitRailWidth(appliedRailWidth.current);
  };
  const resizeRailByKey = (event) => {
    const { min, max } = notebookRailLimits(pageRoot.current?.clientWidth);
    let next = null;
    if (event.key === 'ArrowLeft') next = appliedRailWidth.current - RAIL_KEY_STEP;
    else if (event.key === 'ArrowRight') next = appliedRailWidth.current + RAIL_KEY_STEP;
    else if (event.key === 'Home') next = min;
    else if (event.key === 'End') next = max;
    if (next === null) return;
    event.preventDefault();
    commitRailWidth(next);
  };

  // 读回上一次的宽度：只认数字形态，坏数据回默认宽度。
  useEffect(() => {
    const documents = api.documents;
    if (!documents?.read) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const stored = await documents.read(RAIL_LAYOUT_DOCUMENT);
        if (cancelled) return;
        if (railSave.current.touched || stored?.value?.version !== 1 || typeof stored.value.railWidth !== 'number')
          return;
        const width = clampRailWidth(stored.value.railWidth);
        railWidthRef.current = width;
        const applied = applyRailWidth(width);
        if (mounted.current) setRailWidth(applied);
      } catch {
        // 读不到就用默认宽度
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api.documents, applyRailWidth]);

  // 宽度一变就重新落到变量上（`applyRailWidth` 会按当前可用区域再夹一次）。
  useEffect(() => {
    applyRailWidth(railWidth);
  }, [railWidth, applyRailWidth]);

  // 卸载时收尾：撤掉拖动期的光标状态，把还没写出去的宽度补写一次。
  useEffect(() => {
    const root = pageRoot.current;
    return () => {
      railResize.current = null;
      root?.classList.remove('is-resizing');
      const pending = railSave.current;
      if (pending.timer) {
        clearTimeout(pending.timer);
        pending.timer = null;
        void flushRailRef.current();
      }
    };
  }, []);

  // 拖到一半窗口缩成抽屉形态时命中区会被卸载，这里把拖动状态收干净（不留 cursor）。
  useEffect(() => {
    if (!layout.mobile || !railResize.current) return;
    railResize.current = null;
    pageRoot.current?.classList.remove('is-resizing');
    setRailDragging(false);
  }, [layout.mobile]);

  const commitTitle = useCallback(
    async ({ id, title, baseTitle }) => {
      try {
        const result = await controller.mutateIndex((latest) => {
          const node = latest.nodes.find((entry) => entry.id === id);
          if (!node || node.trashedAt || node.title === title) return latest;
          // Do not let a delayed keystroke overwrite a rename made by another
          // window or by the directory UI while this title was being debounced.
          if (baseTitle && node.title !== baseTitle) return latest;
          return renameNode(latest, id, title, new Date().toISOString());
        });
        return result;
      } catch (cause) {
        if (mounted.current && current.current?.id === id) setError(message(cause));
        return null;
      }
    },
    [controller],
  );
  const flushTitle = useCallback(async () => {
    if (titleTimer.current) {
      clearTimeout(titleTimer.current);
      titleTimer.current = null;
    }
    const next = pendingTitle.current;
    pendingTitle.current = null;
    if (next) await commitTitle(next);
  }, [commitTitle]);
  const scheduleTitle = useCallback(
    (draft, document) => {
      const text = notebookDocumentTitle(document);
      const node = byId.get(draft.id);
      if (text === null || !node) return;
      // 清空标题时笔记名回落成「未命名笔记」，正文那边保持空白，不再被填回旧名字。
      const title = text || '未命名笔记';
      reportedTitle.current = title;
      if (node.title === title) return;
      pendingTitle.current = { id: draft.id, title, baseTitle: node.title };
      if (titleTimer.current) clearTimeout(titleTimer.current);
      titleTimer.current = setTimeout(() => {
        titleTimer.current = null;
        const next = pendingTitle.current;
        pendingTitle.current = null;
        if (next) void commitTitle(next);
      }, 500);
    },
    [byId, commitTitle],
  );
  const save = useCallback(
    async (target = current.current) => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      try {
        await flushTitle();
        await writer.save(target);
        return true;
      } catch (cause) {
        if (mounted.current && current.current === target) setError(message(cause));
        return false;
      }
    },
    [flushTitle, writer],
  );

  const acceptChange = useCallback(
    (id, document) => {
      const draft = drafts.current.get(id);
      if (!draft || current.current !== draft) return;
      uncollected.current = false;
      updateNotebookDraft(draft, document);
      scheduleTitle(draft, document);
      if (!draft.dirty) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void save(draft);
      }, 650);
    },
    [save, scheduleTitle],
  );
  // Index updates change `acceptChange`'s closure. The iframe, however, keeps
  // the same document and must not lose its ready listener just because the
  // directory tree was loaded or renamed. Keep the bridge mounted and route
  // incoming changes through the latest callback instead.
  const acceptChangeRef = useRef(acceptChange);
  acceptChangeRef.current = acceptChange;

  const flush = useCallback(
    async (includeIndex = true) => {
      try {
        if (lifecycle.switching && includeIndex) throw new Error('正在切换笔记，请稍后再返回');
        if (current.current && ready.current && loadedNote.current === current.current.id) {
          const result = await bridge.current.flush();
          if (result.noteId !== current.current.id) throw new Error('笔记切换尚未完成，请稍后再试');
          acceptChange(result.noteId, result.document);
        }
        if (!(await save())) return false;
        if (includeIndex) await controller.flushIndex();
        return true;
      } catch (cause) {
        setError(message(cause));
        return false;
      }
    },
    [controller, save, acceptChange, lifecycle],
  );

  const loadEditor = useCallback(
    async (draft) => {
      const instance = bridge.current;
      if (lifecycle.closing || !ready.current || !instance) return;
      loadedNote.current = null;
      setFrameState('loading');
      instance.freeze(true);
      try {
        await instance.load(draft.id, draft.document, byId.get(draft.id)?.title || '未命名笔记');
        if (bridge.current !== instance || current.current !== draft) return;
        loadedNote.current = draft.id;
        uncollected.current = false;
        setFrameState('ready');
      } catch (cause) {
        if (bridge.current === instance && current.current === draft) setFrameState('error');
        throw cause;
      } finally {
        if (bridge.current === instance) lifecycle.resume();
      }
    },
    [byId, lifecycle],
  );

  const openNote = useCallback(
    async (id) => {
      if (lifecycle.closing || lifecycle.switching) return;
      if (current.current?.id === id && ready.current && loadedNote.current === id) {
        if (layoutRef.current.mobile) setRailOpen(false);
        return;
      }
      setBusy(true);
      try {
        await lifecycle.replace(
          async () => {
            if (!(await flush(false)) || lifecycle.closing) return null;
            const draft = drafts.current.get(id);
            if (draft?.dirty || draft?.unconfirmed) return draft;
            // Revalidate only inactive clean notes after the outgoing save, so a concurrent edit
            // made during that save cannot be hidden by an earlier version check.
            const cached = draft?.version && draft !== current.current
              ? { value: draft.document, version: draft.version, missing: false }
              : undefined;
            const snapshot = await controller.readDocument(id, cached);
            return snapshot === cached ? draft : createNotebookDraft(id, snapshot);
          },
          async (draft) => {
            if (!draft) return;
            rememberNotebookDraft(drafts.current, draft);
            current.current = draft;
            setActiveId(id);
            setSelectedId(id);
            setError('');
            setOutline(emptyOutline());
            loadedNote.current = null;
            await loadEditor(draft);
            // 地址跟着当前笔记走：复制出去、刷新页面都还落在这一篇上。
            api.page?.setSearch?.({ note: id });
            if (layoutRef.current.mobile) setRailOpen(false);
          },
        );
      } catch (cause) {
        setError(message(cause));
      } finally {
        setBusy(false);
      }
    },
    [api, controller, flush, loadEditor, lifecycle],
  );

  actions.current = { flush, openNote, save, loadEditor };

  useEffect(() => {
    setExternalUpdate(null);
    setOutlineCollapsed(new Set());
    reportedTitle.current = '';
  }, [activeId]);

  // Index renames can arrive from the API or another Notebook window. Keep the
  // fixed H1 in the mounted editor aligned without reloading the document.
  useEffect(() => {
    if (!active || !ready.current || loadedNote.current !== active.id || frameState !== 'ready') return;
    // 正文自己刚上报的标题已经写在文档里了；再对齐一次会把清空的标题填回旧名字。
    if (reportedTitle.current === active.title) return;
    bridge.current?.title(active.id, active.title);
  }, [active?.id, active?.title, frameState]);

  // The Notebook can be changed through the API or another Mica host. This check is independent of
  // the removed embedded chat so deleting that UI cannot also disable CAS/conflict feedback.
  useEffect(() => {
    if (!loaded) return undefined;
    const observer = createNotebookExternalUpdateCheck({
      available: () => document.visibilityState === 'visible' && !lifecycle.closing && !lifecycle.switching,
      waitForWrites: () => writer.idle(),
      refreshIndex: () => (controller.getPendingIndexCount() ? Promise.resolve() : controller.loadIndex()),
      current: () => current.current,
      readVersion: async (id) => (await api.documents.version(id)).version,
      changed: setExternalUpdate,
      error: (cause) => {
        if (document.visibilityState === 'visible' && !lifecycle.closing)
          setError(`检查笔记更新失败：${message(cause)}`);
      },
    });
    const refresh = createNotebookPageRefresh({ page: document, window, check: () => observer.check() });
    const unsubscribe = api.sessions?.onExit?.(refresh.request);
    return () => {
      refresh.dispose();
      observer.dispose();
      unsubscribe?.();
    };
  }, [api.sessions, controller, lifecycle, loaded, writer]);

  useEffect(() => {
    let alive = true;
    mounted.current = true;
    void controller
      .loadIndex()
      .then(async (result) => {
        if (!alive) return;
        setLoaded(true);
        // 地址里点名的那一篇优先（深链 / 刷新 / 收藏）；它被删了或者不存在就退回第一篇。
        const requested = deepLink.current?.note;
        const target =
          (requested &&
            result.nodes.find((node) => node.id === requested && node.kind === 'note' && !node.trashedAt)) ||
          result.nodes.find((node) => node.kind === 'note' && !node.trashedAt);
        if (target) {
          setExpanded(
            new Set(
              nodePath(target, nodesById(result))
                .slice(0, -1)
                .map((node) => node.id),
            ),
          );
          await actions.current.openNote(target.id);
        }
      })
      .catch((cause) => {
        if (alive) {
          setError(message(cause));
          setLoaded(true);
        }
      });
    return () => {
      alive = false;
      mounted.current = false;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (titleTimer.current) clearTimeout(titleTimer.current);
      pendingTitle.current = null;
      void actions.current.save();
    };
  }, [controller]);

  // 骨架要「等一小会儿再出现」：热缓存下编辑器通常在这段留白里就已经起来了。
  useEffect(() => {
    if (!hasActiveNote || frameState !== 'loading' || frameBooted) {
      setSkeletonDelayElapsed(false);
      return undefined;
    }
    const timer = setTimeout(() => setSkeletonDelayElapsed(true), EDITOR_SKELETON_DELAY_MS);
    return () => clearTimeout(timer);
  }, [hasActiveNote, frameState, frameBooted]);

  useEffect(() => {
    ready.current = false;
    loadedNote.current = null;
    setFrameBooted(false);
    setFrameState('loading');
    if (!hasActiveNote) return undefined;
    const instance = createEditorBridge({
      token,
      target: () => iframe.current?.contentWindow ?? null,
      onReady() {
        ready.current = true;
        setFrameBooted(true);
        syncTheme();
        // The iframe listener only exists now; re-send the bar insets it needs.
        syncLayout.current();
        if (lifecycle.closing) {
          instance.freeze(true);
          return;
        }
        const draft = current.current;
        if (draft)
          void actions.current.loadEditor(draft).catch((cause) => {
            if (current.current === draft) setError(message(cause));
          });
        else setFrameState('ready');
      },
      onOutline(id, next) {
        if (current.current?.id === id) setOutline(next);
      },
      onModalChange: setEditorModalOpen,
      onChange: (...args) => acceptChangeRef.current(...args),
      onError(text) {
        setError(text);
        if (current.current && loadedNote.current === current.current.id) {
          uncollected.current = true;
        }
        if (!ready.current) setFrameState('error');
      },
    });
    bridge.current = instance;
    function syncTheme() {
      const style = getComputedStyle(document.documentElement);
      const swatch = document.createElement('span');
      swatch.style.setProperty('transition', 'none', 'important');
      swatch.style.setProperty('animation', 'none', 'important');
      swatch.style.visibility = 'hidden';
      swatch.style.position = 'fixed';
      document.body.appendChild(swatch);
      const tokens = {};
      for (const key of [...style]) {
        if (!key.startsWith('--color-')) continue;
        swatch.style.color = `var(${key})`;
        tokens[key] = getComputedStyle(swatch).color;
      }
      tokens['--chat-text-size'] = style.getPropertyValue('--chat-text-size').trim();
      tokens['font-family'] = getComputedStyle(document.body).fontFamily;
      swatch.remove();
      instance.theme(document.documentElement.dataset.appearance || 'light', tokens);
    }
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-appearance'],
    });
    window.addEventListener('message', instance.receive);
    const timer = setTimeout(() => {
      if (!ready.current) {
        setFrameState('error');
        setError('CDN 依赖加载较慢或不可达。笔记仍保存在本机，可稍后重试。');
      }
    }, 45000);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      window.removeEventListener('message', instance.receive);
      instance.dispose();
      if (bridge.current === instance) {
        bridge.current = null;
        ready.current = false;
        loadedNote.current = null;
      }
    };
  }, [token, lifecycle, hasActiveNote]);

  useEffect(() => {
    const beforeUnload = (event) => {
      if (!uncollected.current && !current.current?.dirty && !controller.getPendingIndexCount()) return;
      event.preventDefault();
      event.returnValue = '';
      void save();
    };
    const pagehide = () => {
      void save();
    };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('pagehide', pagehide);
    const stop = api.page?.beforeClose(() => lifecycle.beforeClose(() => actions.current.flush()));
    return () => {
      stop?.();
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('pagehide', pagehide);
    };
  }, [api, controller, save, lifecycle]);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      // 页面宽度变了：目录宽度按新的可用区域重算一次，窗口缩小时正文不会被挤没。
      const applied = applyRailWidth(railWidthRef.current);
      setRailWidth(applied);
      setRailMaxWidth(notebookRailLimits(entry.contentRect.width).max);
      const next = { mobile: entry.contentRect.width <= 760 };
      const previous = layoutRef.current;
      if (previous.mobile === next.mobile) return;
      layoutRef.current = next;
      setLayout(next);
      if (next.mobile !== previous.mobile) setRailOpen(!next.mobile);
    });
    if (pageRoot.current) observer.observe(pageRoot.current);
    return () => observer.disconnect();
  }, [applyRailWidth]);

  // 顶栏与编辑器工具栏是同一行：把两侧实际占的宽度告诉 iframe，让它给工具栏空出同样的位置，
  // 只靠 CSS 猜宽度会在标题变长或增删按钮时互相压住。
  useEffect(() => {
    const send = () => {
      const bar = barLead.current?.parentElement;
      // CSS decides whether the actual editor column can share this row. Page
      // width alone misses a narrow column between the directory and outline.
      const sharedRow = bar && getComputedStyle(bar).position === 'absolute';
      const height = barLead.current?.offsetHeight || barActions.current?.offsetHeight || 0;
      bridge.current?.layout({
        left: sharedRow ? (barLead.current?.offsetWidth ?? 0) : 0,
        right: sharedRow ? (barActions.current?.offsetWidth ?? 0) : 0,
        height: sharedRow ? height : 0,
      });
    };
    send();
    syncLayout.current = send;
    const observer = new ResizeObserver(send);
    for (const node of [barLead.current, barActions.current, barLead.current?.parentElement?.parentElement])
      if (node) observer.observe(node);
    return () => {
      observer.disconnect();
      syncLayout.current = () => {};
    };
  }, [activeId, frameKey, focused, layout.mobile, railOpen]);

  useEffect(() => {
    const escape = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || dialog || menu || apiOpen) return;
      // 大纲是常驻面板，Esc 不去动它；这里只退专注与窄屏目录抽屉。
      if (focused) setFocused(false);
      else if (layout.mobile && railOpen) setRailOpen(false);
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [focused, dialog, menu, apiOpen, railOpen, layout]);

  // iframe 内的点击不冒泡到宿主；焦点进入编辑器时也要收起宿主的菜单。
  useEffect(() => {
    if (!menu) return;
    const closeMenus = () => {
      setMenu(null);
      setDialog((value) => (value?.type === 'rename' ? null : value));
    };
    window.addEventListener('blur', closeMenus);
    return () => window.removeEventListener('blur', closeMenus);
  }, [menu]);

  useEffect(() => {
    const panel = railOverlay ? rail.current : null;
    if (!panel) return;
    const previous = document.activeElement;
    panel.querySelector('button:not(:disabled), input:not(:disabled)')?.focus({ preventScroll: true });
    return () => {
      queueMicrotask(() => {
        if (previous instanceof HTMLElement && previous.isConnected && !previous.closest('[inert]'))
          previous.focus({ preventScroll: true });
      });
    };
  }, [railOverlay]);

  const jump = (target) => {
    if (!activeId || !ready.current || loadedNote.current !== activeId) return;
    bridge.current?.navigate(activeId, target);
  };

  const toggleFolder = (id) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const focusRow = (id) => {
    requestAnimationFrame(() => {
      const row = tree.current?.querySelector(`[data-node-id="${id}"]`);
      if (!row?.getClientRects().length) return;
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: 'nearest' });
    });
  };
  const revealNode = (id, lookup = byId) => {
    const branch = nodePath(lookup.get(id), lookup).filter((entry) => entry.kind === 'folder');
    setExpanded((previous) => new Set([...previous, ...branch.map((entry) => entry.id)]));
    setQuery('');
    setTrash(false);
    setSelectedId(id);
    focusRow(id);
  };
  const toggleAll = () => {
    if (hasExpandedFolder) {
      setExpanded(new Set());
      if (selected?.parentId) setSelectedId(nodePath(selected, byId)[0].id);
    } else {
      setExpanded(new Set(folders.map(({ node }) => node.id)));
    }
  };
  const showMenu = (source, node) => {
    if (busy || creating.current) return;
    // 同一个节点的改名表单已经开着时，重复的「打开菜单」不该把它顶掉。
    setDialog((value) => (value?.type === 'rename' && node && value.node.id === node.id ? value : null));
    if (node && source !== 'header') setSelectedId(node.id);
    setMenu({ source, id: node?.id });
  };
  const closeMenu = () => {
    if (busy) return;
    setMenu(null);
    setDialog((value) => (value?.type === 'rename' ? null : value));
  };
  const parentForNew =
    selected && !selected.trashedAt ? (selected.kind === 'folder' ? selected.id : selected.parentId) : null;
  const mutate = async (operation) => {
    if (lifecycle.closing) return null;
    setBusy(true);
    try {
      operation(index);
      const result = await controller.mutateIndex(operation);
      setError('');
      return result;
    } catch (cause) {
      setError(message(cause));
      return null;
    } finally {
      setBusy(false);
    }
  };
  const loadLatest = async () => {
    const draft = current.current;
    if (!draft || lifecycle.closing || lifecycle.switching) return;
    setBusy(true);
    try {
      await lifecycle.replace(
        async () => {
          if (ready.current && loadedNote.current === draft.id) {
            const result = await bridge.current.flush();
            acceptChange(result.noteId, result.document);
          }
          if (saveTimer.current) {
            clearTimeout(saveTimer.current);
            saveTimer.current = null;
          }
          // Let acknowledged writes advance this draft before replacing it with a disk snapshot.
          await writer.idle();
          if (lifecycle.closing) return null;
          download(draft.document, `${active?.title || '笔记'}-冲突草稿`);
          return createNotebookDraft(draft.id, await controller.readDocument(draft.id));
        },
        async (latest) => {
          if (!latest) return;
          rememberNotebookDraft(drafts.current, latest);
          current.current = latest;
          await loadEditor(latest);
          setError('');
          setExternalUpdate(null);
          setDialog(null);
        },
      );
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const create = async (kind, parentId = parentForNew) => {
    if (busy || creating.current || lifecycle.closing || lifecycle.switching) return;
    if (kind === 'folder') {
      setDialog({
        type: 'create',
        id: createNodeId(),
        now: new Date().toISOString(),
        kind,
        title: '新建文件夹',
        name: '',
        parentId,
      });
      return;
    }
    creating.current = true;
    setBusy(true);
    try {
      const id = createNodeId();
      const now = new Date().toISOString();
      if (!(await flush()) || lifecycle.closing) return;
      const result = await mutate(createDefaultNote({ id, now, parentId }));
      if (!result || lifecycle.closing) return;
      revealNode(id, nodesById(result));
      await openNote(id);
    } finally {
      creating.current = false;
      setBusy(false);
    }
  };
  const edit = (node) => setDialog({ type: 'rename', node, title: '重命名', name: node.title });
  /**
   * 双击（手机上是双击、桌面是双击）直接改名：行尾菜单只用来给改名表单当定位锚，
   * 用户看到的就是那一行旁边的输入框。菜单开着时表单才渲染，所以两件事一起设置。
   */
  const startRename = (node) => {
    if (trash || busy || creating.current || lifecycle.closing || lifecycle.switching) return;
    setSelectedId(node.id);
    setMenu({ source: 'row', id: node.id });
    edit(node);
  };
  const runAction = (node, action) => {
    if (action === 'note' || action === 'folder') {
      setMenu(null);
      void create(action, node.id);
      return;
    }
    if (action === 'rename') edit(node);
    else if (action === 'copy') {
      setMenu(null);
      void copyRowName(node);
    } else if (action === 'move') {
      setMenu(null);
      setDialog({ type: 'move', title: '移动到', node, parentId: node.parentId || '' });
    } else {
      setMenu(null);
      setDialog({ type: 'delete', title: '移到最近删除', node });
    }
  };
  const submitDialog = async () => {
    const value = dialog;
    if (!value || busy || lifecycle.closing) return;
    if (value.type === 'reload') {
      await loadLatest();
      return;
    }
    if (value.type === 'delete') {
      if (!(await flush())) return;
      const now = new Date().toISOString();
      const result = await mutate((latest) => trashNode(latest, value.node.id, now));
      if (!result || lifecycle.closing) return;
      const removed = result.nodes.find((node) => node.id === current.current?.id)?.trashedAt;
      if (removed) {
        current.current = null;
        bridge.current?.freeze(true);
        setActiveId(null);
        loadedNote.current = null;
        setOutline(emptyOutline());
        setExternalUpdate(null);
        api.page?.setSearch?.({});
      }
    } else if (value.type === 'move') {
      const now = new Date().toISOString();
      const result = await mutate((latest) => moveNode(latest, value.node.id, value.parentId || null, now));
      if (!result) return;
      revealNode(value.node.id, nodesById(result));
    } else if (value.type === 'rename') {
      if (pendingTitle.current?.id === value.node.id) {
        pendingTitle.current = null;
        if (titleTimer.current) {
          clearTimeout(titleTimer.current);
          titleTimer.current = null;
        }
      }
      const now = new Date().toISOString();
      const result = await mutate((latest) => renameNode(latest, value.node.id, value.name, now));
      if (!result) return;
      const renamed = result.nodes.find((node) => node.id === value.node.id);
      if (current.current?.id === value.node.id && renamed) bridge.current?.title(value.node.id, renamed.title);
    } else {
      if (!(await flush())) return;
      const { id, now } = value;
      const result = await mutate((latest) =>
        latest.nodes.some((node) => node.id === id)
          ? latest
          : createNode(latest, { id, now, kind: value.kind, title: value.name, parentId: value.parentId }),
      );
      if (!result || lifecycle.closing) return;
      revealNode(id, nodesById(result));
    }
    setDialog(null);
    setMenu(null);
  };

  const hoverDrop = (event, target) => {
    if (!dragSource.current) return;
    event.stopPropagation();
    const resolved = canArrange ? resolveNotebookDrop(index, dragSource.current, target) : null;
    event.dataTransfer.dropEffect = resolved ? 'move' : 'none';
    if (resolved) event.preventDefault();
    setDropTarget((previous) =>
      previous?.targetId === resolved?.targetId && previous?.position === resolved?.position ? previous : resolved,
    );
    if (resolved?.position === 'inside' && resolved.targetId && !expanded.has(resolved.targetId)) {
      if (folderHover.current?.id !== resolved.targetId) {
        clearFolderHover();
        const id = resolved.targetId;
        folderHover.current = {
          id,
          timer: setTimeout(() => {
            setExpanded((previous) => new Set([...previous, id]));
            folderHover.current = null;
          }, 600),
        };
      }
    } else clearFolderHover();
  };
  const finishDrop = async (event, target) => {
    const sourceId = dragSource.current;
    if (!sourceId) return;
    event.preventDefault();
    event.stopPropagation();
    const resolved = canArrange ? resolveNotebookDrop(index, sourceId, target) : null;
    clearDrag();
    if (!resolved || creating.current || lifecycle.closing) return;
    const now = new Date().toISOString();
    const result = await mutate((latest) => placeNode(latest, sourceId, resolved, now));
    if (!result || lifecycle.closing) return;
    setSelectedId(sourceId);
    const parentId = result.nodes.find((node) => node.id === sourceId)?.parentId;
    if (parentId) setExpanded((previous) => new Set([...previous, parentId]));
  };
  const rowDrop = (event, node) => ({
    targetId: node.id,
    position: notebookDropPosition(node.kind, event.clientY, event.currentTarget.getBoundingClientRect()),
  });

  const selectRow = (node) => {
    if (lifecycle.closing || busy || creating.current) return;
    setSelectedId(node.id);
    if (trash) return;
    if (searchTerm) revealNode(node.id);
    if (node.kind === 'note') void openNote(node.id);
    else if (!searchTerm) toggleFolder(node.id);
  };
  /**
   * 目录行的一次点击：正在这一行里选字时什么也不做（手机长按选字之后不要顺手打开笔记），
   * 否则记一次点击；同一行的第二次点击直接进入改名。
   */
  const handleRowClick = (event, node) => {
    const selection = window.getSelection?.();
    const selecting = !!selection && !selection.isCollapsed && event.currentTarget.contains(selection.anchorNode);
    if (selecting) return;
    const tap = notebookRowTap(lastRowTap.current, node.id, event.timeStamp || Date.now());
    lastRowTap.current = tap.next;
    if (tap.rename) {
      // 双击会顺手选中一个词；进入改名时把那一段选区收掉。
      selection?.removeAllRanges?.();
      startRename(node);
      return;
    }
    // 行不再是 <button>（要允许选字），键盘导航得自己把焦点放到点中的行上。
    event.currentTarget.focus({ preventScroll: true });
    selectRow(node);
  };
  const navigateTree = (event) => {
    if (event.defaultPrevented || !event.target.matches('[role="treeitem"]')) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft', 'Enter', ' ', 'F2'].includes(event.key))
      return;
    if (busy || creating.current) return;
    const position = visible.findIndex(({ node }) => node.id === event.target.dataset.nodeId);
    const row = visible[position];
    if (event.key === 'F2' && row && !trash) {
      event.preventDefault();
      startRename(row.node);
      return;
    }
    // 行是 div：Enter/Space 的「按下即激活」要自己补上，与原来的 <button> 一致。
    if ((event.key === 'Enter' || event.key === ' ') && row) {
      event.preventDefault();
      selectRow(row.node);
      return;
    }
    let target;
    if (event.key === 'ArrowDown') target = visible[Math.min(visible.length - 1, position + 1)];
    if (event.key === 'ArrowUp') target = visible[Math.max(0, position - 1)];
    if (event.key === 'Home') target = visible[0];
    if (event.key === 'End') target = visible.at(-1);
    if (event.key === 'ArrowRight' && row?.hasChildren && !searchTerm && !trash) {
      if (!expanded.has(row.node.id)) toggleFolder(row.node.id);
      else target = visible[position + 1];
    }
    if (event.key === 'ArrowLeft' && row && !searchTerm && !trash) {
      if (expanded.has(row.node.id)) toggleFolder(row.node.id);
      else target = visible.find(({ node }) => node.id === row.node.parentId);
    }
    if (target) {
      setSelectedId(target.node.id);
      focusRow(target.node.id);
    }
    event.preventDefault();
  };

  const path = useMemo(() => nodePath(active, byId).map((node) => node.title), [active, byId]);
  const forbidden = new Set(dialog?.type === 'move' ? [dialog.node.id] : []);
  if (dialog?.type === 'move') {
    // The full directory is in parent-first order; no repeated traversal on dragover renders.
    for (const { node } of folders) if (forbidden.has(node.parentId)) forbidden.add(node.id);
  }
  const folderOptions =
    dialog?.type === 'move'
      ? folders
          .filter(({ node }) => !forbidden.has(node.id))
          .map(({ node }) => ({
            value: node.id,
            label: nodePath(node, byId)
              .map((entry) => entry.title)
              .join(' / '),
          }))
      : [];
  const repeatedPaths = new Set(
    folderOptions
      .filter((option, index, all) => all.findIndex((item) => item.label === option.label) !== index)
      .map((option) => option.label),
  );
  for (const option of folderOptions) {
    if (repeatedPaths.has(option.label)) option.label += `（${option.value}）`;
  }

  const outlineTree = useMemo(() => {
    const roots = [];
    const stack = [];
    for (const item of outline.items) {
      const entry = { ...item, children: [] };
      while (stack.length && stack.at(-1).level >= item.level) stack.pop();
      if (stack.length) stack.at(-1).children.push(entry);
      else roots.push(entry);
      stack.push(entry);
    }
    return roots;
  }, [outline.items]);

  const outlineAncestors = useMemo(() => {
    const parents = new Map();
    const stack = [];
    for (const item of outline.items) {
      while (stack.length && stack.at(-1).level >= item.level) stack.pop();
      parents.set(
        item.key,
        stack.map((entry) => entry.key),
      );
      stack.push(item);
    }
    return parents;
  }, [outline.items]);

  useEffect(() => {
    if (!outline.activeKey) return;
    const ancestors = outlineAncestors.get(outline.activeKey) || [];
    setOutlineCollapsed((previous) => {
      const next = new Set(previous);
      let changed = false;
      for (const key of ancestors) {
        if (next.delete(key)) changed = true;
      }
      return changed ? next : previous;
    });
    if (!outlineAvailable) return;
    const frame = requestAnimationFrame(() =>
      outlineItemRefs.current.get(outline.activeKey)?.scrollIntoView({ block: 'nearest' }),
    );
    return () => cancelAnimationFrame(frame);
  }, [outline.activeKey, outlineAncestors, outlineAvailable]);

  const outlineEntries = (entries) =>
    entries.flatMap((item) => {
      const currentHeading = item.key === outline.activeKey;
      const collapsed = outlineCollapsed.has(item.key);
      const button = (
        <div
          key={item.key}
          className="notebook-outline-tree-entry"
          ref={(element) => {
            if (element) outlineItemRefs.current.set(item.key, element);
            else outlineItemRefs.current.delete(item.key);
          }}
        >
          <Button
            variant="ghost"
            fullWidth
            className={`mica-arco-row notebook-outline-entry ${currentHeading ? 'is-active' : ''}`}
            style={{ '--heading-level': item.level }}
            aria-current={currentHeading ? 'location' : undefined}
            aria-level={item.level}
            aria-expanded={item.children.length ? !collapsed : undefined}
            title={item.text || '未命名标题'}
            disabled={busy}
            onClick={() => jump({ heading: item.key })}
          >
            {item.children.length ? (
              <span
                className="notebook-outline-toggle"
                onClick={(event) => {
                  event.stopPropagation();
                  setOutlineCollapsed((previous) => {
                    const next = new Set(previous);
                    if (next.has(item.key)) next.delete(item.key);
                    else next.add(item.key);
                    return next;
                  });
                }}
              >
                {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              </span>
            ) : (
              <span className="notebook-outline-toggle notebook-outline-toggle-empty" />
            )}
            <span>{item.text || '未命名标题'}</span>
          </Button>
        </div>
      );
      return collapsed ? [button] : [button, ...outlineEntries(item.children)];
    });

  const localForm =
    dialog?.type === 'rename' ? (
      <div
        className="notebook-dialog"
        style={{ width: 'min(240px, 75vw)' }}
        role="dialog"
        aria-label={dialog.title}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape' && !busy) {
            event.preventDefault();
            setDialog(null);
            setMenu(null);
          }
        }}
      >
        <label>
          名称
          <Input
            autoFocus
            value={dialog.name}
            maxLength={100}
            aria-label="名称"
            onChange={(name) => setDialog({ ...dialog, name })}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing && dialog.name.trim()) void submitDialog();
            }}
          />
        </label>
        <footer>
          <Button
            onClick={() => {
              setDialog(null);
              setMenu(null);
            }}
            disabled={busy}
          >
            取消
          </Button>
          <Button variant="accent" disabled={busy || !dialog.name.trim()} onClick={() => void submitDialog()}>
            {busy ? '处理中' : '确定'}
          </Button>
        </footer>
      </div>
    ) : null;

  return (
    <div ref={pageRoot} className={`notebook-page ${railOpen ? 'is-rail-open' : ''} ${focused ? 'is-focused' : ''} ${editorModalOpen ? 'is-editor-modal-open' : ''}`}>
      <div className="notebook-layout">
        <aside ref={rail} className="notebook-rail" aria-label="笔记目录" inert={editorModalOpen}>
          <div className="notebook-rail-title">
            <span className="notebook-book-icon" aria-hidden="true">
              <BookMarked size={22} strokeWidth={1.6} />
            </span>
            <div className="notebook-book-info">
              <strong>我的笔记</strong>
              <span>{loaded ? `${noteCount} 篇笔记` : '\u00a0'}</span>
            </div>
            <Button
              variant="ghost"
              icon={<PanelLeftClose size={15} />}
              title="收起目录"
              aria-label="收起目录"
              onClick={() => setRailOpen(false)}
            />
          </div>
          <div className="notebook-rail-tools">
            <div className="notebook-search">
              <Input
                value={query}
                onChange={setQuery}
                placeholder="搜索笔记"
                aria-label="搜索笔记"
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === 'Escape' && query) {
                    event.preventDefault();
                    setQuery('');
                  } else if (event.key === 'ArrowDown' && visible.length) {
                    event.preventDefault();
                    setSelectedId(visible[0].node.id);
                    focusRow(visible[0].node.id);
                  } else if (event.key === 'Enter' && searchTerm && visible.length) {
                    event.preventDefault();
                    selectRow(visible[0].node);
                  }
                }}
                prefix={<Search size={15} strokeWidth={1.7} />}
                allowClear
              />
            </div>
            <CreateMenu
              toolbar
              label="新建"
              title={`在「${byId.get(parentForNew)?.title || '根目录'}」中新建`}
              open={menu?.source === 'new'}
              onOpen={() => showMenu('new')}
              onClose={closeMenu}
              disabled={!loaded || busy || trash}
              onCreate={(kind) => {
                setMenu(null);
                void create(kind);
              }}
            />
          </div>
          {trash ? (
            <div className="notebook-tree-heading">
              <span>
                <Trash2 size={15} /> 最近删除 <small>{visible.length}</small>
              </span>
            </div>
          ) : (
            <div className="notebook-tree-heading">
              <Button
                variant="ghost"
                size="compact"
                className={`notebook-root-target mica-arco-row ${dropTarget?.targetId === null ? 'is-drop-inside' : ''}`}
                icon={<ListTree size={16} />}
                title="选择根目录，拖到这里可移至顶层"
                pressed={selectedId === null && !searchTerm}
                disabled={!loaded || busy}
                onClick={() => {
                  setQuery('');
                  setSelectedId(null);
                }}
                onDragOver={(event) => hoverDrop(event, { targetId: null, position: 'inside' })}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) {
                    setDropTarget(null);
                    clearFolderHover();
                  }
                }}
                onDrop={(event) => void finishDrop(event, { targetId: null, position: 'inside' })}
              >
                {searchTerm ? `搜索结果（${visible.length}）` : '目录'}
              </Button>
              <div className="notebook-tree-tools">
                <Button
                  variant="ghost"
                  icon={<LocateFixed size={16} />}
                  title="定位当前笔记"
                  disabled={!active || busy}
                  onClick={() => revealNode(active.id)}
                />
                <Button
                  variant="ghost"
                  icon={hasExpandedFolder ? <ChevronsDownUp size={16} /> : <ChevronsUpDown size={16} />}
                  title={hasExpandedFolder ? '折叠全部文件夹' : '展开全部文件夹'}
                  disabled={busy || !!searchTerm || !folders.some(({ hasChildren }) => hasChildren)}
                  onClick={toggleAll}
                />
              </div>
              {draggingId && <span className="notebook-drag-hint">行间排序 · 拖入文件夹归档</span>}
              {!draggingId && copyHint && <span className="notebook-drag-hint">{copyHint}</span>}
            </div>
          )}
          <div
            className="notebook-tree"
            role="tree"
            aria-label={trash ? '最近删除' : '笔记目录树'}
            ref={tree}
            onKeyDown={navigateTree}
            onDragOver={(event) => hoverDrop(event, { targetId: null, position: 'inside' })}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                setDropTarget(null);
                clearFolderHover();
              }
            }}
            onDrop={(event) => void finishDrop(event, { targetId: null, position: 'inside' })}
          >
            {!loaded ? (
              <div className="notebook-tree-skeleton">
                <i />
                <i />
                <i />
              </div>
            ) : visible.length ? (
              visible.map(({ node, depth, hasChildren }) => (
                <div
                  className={`notebook-tree-entry ${node.id === selectedId ? 'is-selected' : ''} ${node.id === activeId ? 'is-active' : ''} ${draggingId === node.id ? 'is-dragging' : ''} ${dropMarker?.targetId === node.id ? `is-drop-${dropMarker.position}` : ''}`}
                  key={node.id}
                  data-kind={node.kind}
                  style={{
                    '--depth': searchTerm ? 0 : depth,
                    '--drop-depth': dropMarker?.targetId === node.id ? (dropMarker.depth ?? depth) : depth,
                  }}
                  onDragOver={(event) => {
                    event.stopPropagation();
                    hoverDrop(event, rowDrop(event, node));
                  }}
                  onDrop={(event) => void finishDrop(event, rowDrop(event, node))}
                >
                  <div
                    role="treeitem"
                    aria-selected={node.id === selectedId}
                    aria-current={node.id === activeId ? 'page' : undefined}
                    aria-expanded={hasChildren && !searchTerm ? trash || expanded.has(node.id) : undefined}
                    aria-level={searchTerm ? 1 : depth + 1}
                    data-node-id={node.id}
                    tabIndex={node.id === tabStop ? 0 : -1}
                    title={node.title}
                    className="notebook-tree-row"
                    onClick={(event) => handleRowClick(event, node)}
                    onContextMenu={(event) => {
                      if (trash) return;
                      event.preventDefault();
                      showMenu('row', node);
                    }}
                    draggable={canArrange}
                    onDragStart={(event) => {
                      if (!canArrange || creating.current || lifecycle.closing || lifecycle.switching) {
                        event.preventDefault();
                        return;
                      }
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('application/x-mica-notebook-node', node.id);
                      dragSource.current = node.id;
                      setDraggingId(node.id);
                      setSelectedId(node.id);
                      setMenu(null);
                    }}
                    onDragEnd={clearDrag}
                  >
                    <span className="notebook-tree-chevron" aria-hidden="true">
                      {node.kind === 'folder' &&
                        (trash || (!searchTerm && expanded.has(node.id)) ? (
                          <ChevronDown size={14} />
                        ) : (
                          <ChevronRight size={14} />
                        ))}
                    </span>
                    <span className="notebook-tree-title">
                      <span>{node.title}</span>
                      {searchTerm && (
                        <small>
                          {nodePath(byId.get(node.parentId), byId)
                            .map((entry) => entry.title)
                            .join(' / ') || '我的笔记'}
                        </small>
                      )}
                    </span>
                  </div>
                  {trash ? (
                    <Button
                      variant="ghost"
                      icon={<Undo2 size={13} />}
                      title="恢复"
                      aria-label={`恢复：${node.title}`}
                      className="notebook-row-actions"
                      tabIndex={node.id === tabStop ? 0 : -1}
                      onClick={() => {
                        let root = node;
                        while (byId.get(root.parentId)?.trashedAt) root = byId.get(root.parentId);
                        const now = new Date().toISOString();
                        void mutate((latest) => restoreNode(latest, root.id, now));
                      }}
                    />
                  ) : (
                    <span className="notebook-row-actions">
                      {node.kind === 'folder' && (
                        <CreateMenu
                          label={`在「${node.title}」中新建`}
                          tabIndex={node.id === tabStop ? 0 : -1}
                          open={menu?.id === node.id && menu.source === 'create'}
                          onOpen={() => showMenu('create', node)}
                          onClose={closeMenu}
                          disabled={busy}
                          onCreate={(kind) => runAction(node, kind)}
                        />
                      )}
                      <NoteMenu
                        node={node}
                        open={menu?.id === node.id && menu.source === 'row'}
                        onOpen={() => showMenu('row', node)}
                        onClose={closeMenu}
                        onAction={(action) => runAction(node, action)}
                        form={menu?.id === node.id && menu.source === 'row' ? localForm : null}
                        trigger={
                          <span className="notebook-menu-anchor">
                            <Button
                              variant="ghost"
                              icon={<YuqueIcon name="more" size={15} />}
                              title={`更多操作：${node.title}`}
                              tabIndex={node.id === tabStop ? 0 : -1}
                              aria-haspopup="menu"
                              aria-expanded={menu?.id === node.id && menu.source === 'row'}
                              pressed={menu?.id === node.id && menu.source === 'row'}
                              disabled={busy}
                            />
                          </span>
                        }
                      />
                    </span>
                  )}
                </div>
              ))
            ) : (
              <div className="notebook-tree-empty">
                {searchTerm ? '没有匹配的笔记' : trash ? '还没有删除的内容' : '还没有笔记'}
              </div>
            )}
          </div>
          <div className="notebook-rail-footer">
            <span title="笔记自动保存在本机">
              <ShieldCheck size={12} />
              本地存储
            </span>
            <div className="notebook-rail-footer-actions">
              {/* HTTP 接口的地址放在页面上：它属于这个笔记本，不属于设置页。 */}
              <Button
                variant="ghost"
                size="compact"
                icon={<Plug size={13} />}
                title="查看笔记本的 HTTP 接口"
                onClick={() => setApiOpen(true)}
              >
                API
              </Button>
              <Button
                variant="ghost"
                size="compact"
                icon={trash ? <BookOpen size={13} /> : <Trash2 size={13} />}
                onClick={() => {
                  setTrash(!trash);
                  setQuery('');
                }}
              >
                {trash ? '返回笔记' : '最近删除'}
              </Button>
            </div>
          </div>
        </aside>
        {/* 目录右缘的拖动命中区：桌面才有，窄屏的抽屉保持自己的宽度。 */}
        {!layout.mobile && railOpen && !focused && (
          <div
            className="notebook-rail-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整目录宽度"
            aria-valuemin={RAIL_MIN_WIDTH}
            aria-valuemax={railMaxWidth}
            aria-valuenow={railWidth}
            title="拖动调整目录宽度，双击恢复默认"
            tabIndex={0}
            data-resizing={railDragging ? 'true' : undefined}
            onPointerDown={startRailResize}
            onPointerMove={moveRailResize}
            onPointerUp={endRailResize}
            onPointerCancel={endRailResize}
            onLostPointerCapture={endRailResize}
            onKeyDown={resizeRailByKey}
            onDoubleClick={() => commitRailWidth(RAIL_DEFAULT_WIDTH)}
          />
        )}
        {railOpen && (
          <button
            type="button"
            className="notebook-mobile-mask"
            tabIndex={-1}
            aria-label="关闭目录"
            onClick={() => setRailOpen(false)}
          />
        )}
        <main className="notebook-main" inert={railOverlay}>
          {externalUpdate === current.current?.id && (
            <div className="notebook-error" role="status">
              <span>这篇笔记已在其他窗口或接口调用中修改。当前草稿未被替换；加载前会备份当前内容。</span>
              <Button
                size="compact"
                variant="ghost"
                disabled={busy}
                onClick={() => setDialog({ type: 'reload', title: '备份草稿并加载最新版' })}
              >
                查看更新
              </Button>
            </div>
          )}
          {error && (
            <div className="notebook-error">
              <Alert message={error} />
              <div>
                {current.current?.dirty && (
                  <Button
                    size="compact"
                    variant="ghost"
                    onClick={() => download(current.current.document, `${active?.title || '笔记'}-草稿`)}
                  >
                    下载草稿
                  </Button>
                )}
                <Button
                  size="compact"
                  variant="ghost"
                  onClick={async () => {
                    const ok = await flush();
                    if (ok) setError('');
                  }}
                >
                  重试保存
                </Button>
                {current.current?.dirty && (
                  <Button
                    size="compact"
                    variant="ghost"
                    onClick={() => setDialog({ type: 'reload', title: '备份草稿并加载最新版' })}
                  >
                    加载最新版
                  </Button>
                )}
                <Button
                  size="compact"
                  variant="ghost"
                  icon={<X size={13} />}
                  aria-label="收起提示"
                  onClick={() => setError('')}
                />
              </div>
            </div>
          )}
          <div className="notebook-document-body">
            <div className={`notebook-editor-area ${active ? 'has-note' : ''}`}>
              <div className="notebook-bar" inert={editorModalOpen}>
                <div className="notebook-bar-lead" ref={barLead}>
                  {(focused || !railOpen) && (
                    <Button
                      variant="ghost"
                      icon={<PanelLeftOpen size={16} />}
                      title={focused ? '显示目录并退出专注' : '展开目录'}
                      onClick={() => {
                        setFocused(false);
                        setOutlineOpen(false);
                        setRailOpen(true);
                      }}
                    />
                  )}
                  {active && (
                    <span className="notebook-breadcrumb" title={path.join(' / ')}>
                      {(!railOpen || focused) && path.length > 1 && <span>{path.at(-2)} /</span>}
                      <strong>{active.title}</strong>
                    </span>
                  )}
                </div>
                <div className="notebook-bar-actions" ref={barActions}>
                  {active && (
                    <>
                      <Button
                        variant="ghost"
                        icon={<SlidersHorizontal size={16} strokeWidth={1.6} />}
                        title="样式设置"
                        aria-label="样式设置"
                        disabled={busy || frameState !== 'ready'}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => bridge.current?.action(active.id, 'style')}
                      />
                      <Button
                        variant="ghost"
                        icon={<Focus size={16} />}
                        title={focused ? '退出专注' : '专注写作'}
                        aria-label={focused ? '退出专注' : '专注写作'}
                        pressed={focused}
                        onClick={() => setFocused(!focused)}
                      />
                      <NoteMenu
                        node={active}
                        open={menu?.id === active.id && menu.source === 'header'}
                        onOpen={() => showMenu('header', active)}
                        onClose={closeMenu}
                        onAction={(action) => runAction(active, action)}
                        form={menu?.id === active.id && menu.source === 'header' ? localForm : null}
                        position="bl"
                        extraRows={
                          <>
                            <MenuRow
                              action="focus"
                              label={focused ? '退出专注' : '专注写作'}
                              Icon={Focus}
                              onSelect={() => {
                                setMenu(null);
                                setFocused(!focused);
                              }}
                            />
                          </>
                        }
                        trigger={
                          /* 开合由浮层的 onVisibleChange 驱动，按钮自己不切换状态。 */
                          <span className="notebook-menu-anchor">
                            <Button
                              variant="ghost"
                              icon={<YuqueIcon name="more" />}
                              title="笔记操作"
                              aria-label="笔记操作"
                              pressed={menu?.id === active.id && menu.source === 'header'}
                              onClick={() => {}}
                            />
                          </span>
                        }
                      />
                    </>
                  )}
                </div>
              </div>
              {active && (
                <iframe
                  key={frameKey}
                  ref={iframe}
                  className="notebook-editor-frame"
                  title="笔记富文本编辑器"
                  src={`/editor/index.html#${token}`}
                  sandbox="allow-scripts allow-downloads allow-popups"
                  allow="clipboard-read; clipboard-write; fullscreen"
                />
              )}
              {!active ? (
                <div className="notebook-welcome">
                  <span className="notebook-welcome-icon">
                    <BookOpen size={32} strokeWidth={1.4} />
                  </span>
                  <h1>
                    {index.nodes.some((node) => node.kind === 'note' && !node.trashedAt)
                      ? '选择一篇笔记'
                      : '还没有笔记'}
                  </h1>
                  <p>把想法写下来，慢慢整理成自己的知识。</p>
                  <Button
                    variant="accent"
                    icon={<Plus size={16} />}
                    disabled={!loaded || busy}
                    onClick={() => create('note')}
                  >
                    新建笔记
                  </Button>
                </div>
              ) : overlay === 'skeleton' ? (
                <div className="notebook-editor-skeleton">
                  <i />
                  <i />
                  <i />
                  <i />
                  <span>正在启动编辑器：首次打开需要联网下载依赖，之后走本机缓存，笔记内容只保存在本机。</span>
                </div>
              ) : overlay === 'error' ? (
                <div className="notebook-load-error">
                  <Empty
                    title="编辑器暂时无法加载"
                    description="请检查 CDN 网络连接。正文仍保存在本机，重试不会清空笔记。"
                  />
                  <Button
                    icon={<RefreshCw size={14} />}
                    onClick={() => {
                      if (!lifecycle.closing && !lifecycle.switching && !current.current?.dirty) {
                        setError('');
                        setFrameKey((key) => key + 1);
                      }
                    }}
                  >
                    重新加载编辑器
                  </Button>
                </div>
              ) : null}
            </div>
            {outlineAvailable &&
              (outlineOpen ? (
                <aside className="notebook-outline" aria-label="文档大纲" inert={editorModalOpen}>
                  <header>
                    <strong>文档大纲</strong>
                    <Button
                      variant="ghost"
                      icon={<YuqueIcon name="outline" />}
                      title="隐藏文档大纲"
                      aria-label="隐藏文档大纲"
                      onClick={() => setOutlineOpen(false)}
                    />
                  </header>
                  <nav className="notebook-outline-list" aria-label="当前笔记的标题">
                    {outline.items.length ? (
                      outlineEntries(outlineTree)
                    ) : (
                      <p className="notebook-outline-empty">
                        {frameState === 'ready' ? '这篇笔记还没有标题' : '正在读取标题…'}
                      </p>
                    )}
                  </nav>
                </aside>
              ) : (
                <button
                  type="button"
                  className="notebook-outline-rail"
                  aria-label="显示文档大纲"
                  title="显示文档大纲"
                  onClick={() => setOutlineOpen(true)}
                >
                  <span className="notebook-outline-rail-ticks" aria-hidden="true">
                    {outline.items.length ? (
                      outline.items.map((item, index) => (
                        <i
                          key={item.key}
                          data-level={Math.min(6, Math.max(1, item.level))}
                          className={item.key === outline.activeKey ? 'is-active' : undefined}
                          style={{
                            '--outline-rail-hue': Math.round(
                              205 - (index / Math.max(1, outline.items.length - 1)) * 245,
                            ),
                          }}
                        />
                      ))
                    ) : (
                      <i className="is-empty" />
                    )}
                  </span>
                  <span className="notebook-outline-rail-icon">
                    <YuqueIcon name="outline" size={13} />
                  </span>
                </button>
              ))}
          </div>
        </main>
      </div>
      {apiOpen && (
        <Modal title="Notebook API" onClose={() => setApiOpen(false)} portal>
          <div className="notebook-api">
            <p>
              本机笔记既可在这张页面编辑，也可用 HTTP 接口读写；调用时保持 Mica 应用运行。根地址是目录：先读
              <code>/guide</code>，再按任务翻 <code>/modules/&lt;id&gt;</code>。
            </p>
            <div className="notebook-api-field">
              <span>接口地址</span>
              <div className="notebook-api-value">
                <code>{apiBase}</code>
                <Button variant="ghost" size="compact" onClick={() => void copyText(apiBase, 'url')}>
                  {copied === 'url' ? '已复制' : '复制'}
                </Button>
              </div>
            </div>
            <div className="notebook-api-field">
              <span>接口文档</span>
              <div className="notebook-api-value">
                <code>{apiBase}</code>
                <Button variant="ghost" size="compact" onClick={() => void copyText(apiBase, 'doc')}>
                  {copied === 'doc' ? '已复制' : '复制'}
                </Button>
              </div>
              <pre className="notebook-api-code">{overviewCurl}</pre>
              <div className="notebook-api-actions">
                <Button variant="ghost" size="compact" onClick={() => void copyText(`${apiBase}/guide`, 'guide')}>
                  {copied === 'guide' ? '已复制' : '复制导读地址'}
                </Button>
                <Button variant="ghost" size="compact" onClick={() => void copyText(overviewCurl, 'curl')}>
                  {copied === 'curl' ? '已复制' : '复制 curl'}
                </Button>
              </div>
            </div>
            <p>
              正文写入要带上刚读到的 <code>expected_version</code>，版本冲突返回 409；删除只是可恢复的最近删除。
            </p>
            <p className="notebook-api-hint">
              桌面端与 Web 应用的「笔记」角色已让模型按这份接口操作；接口只在 Mica 运行时里存在（TUI
              与外部客户端需要应用在运行）。
            </p>
          </div>
        </Modal>
      )}
      {dialog && dialog.type !== 'rename' && (
        <Modal title={dialog.title} onClose={() => !busy && setDialog(null)} portal>
          <div className="notebook-dialog">
            {dialog.type === 'reload' ? (
              <p>将先下载当前草稿备份，再载入磁盘上的最新正文。不会覆盖其他窗口的内容。</p>
            ) : dialog.type === 'delete' ? (
              <p>
                将「{dialog.node.title}」{dialog.node.kind === 'folder' ? '及其全部内容' : ''}
                移到最近删除？之后可以恢复，正文文件不会被删除。
              </p>
            ) : dialog.type === 'move' ? (
              <label>
                目标文件夹
                <SelectMenu
                  value={dialog.parentId}
                  ariaLabel="目标文件夹"
                  options={[{ value: '', label: '我的笔记（根目录）' }, ...folderOptions]}
                  onChange={(parentId) => setDialog({ ...dialog, parentId })}
                />
              </label>
            ) : (
              <label>
                名称
                <Input
                  autoFocus
                  value={dialog.name}
                  maxLength={100}
                  placeholder={dialog.kind === 'folder' ? '文件夹名称' : '笔记标题'}
                  aria-label="名称"
                  onChange={(name) => setDialog({ ...dialog, name })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing && dialog.name.trim())
                      void submitDialog();
                  }}
                />
              </label>
            )}
            <footer>
              <Button onClick={() => setDialog(null)} disabled={busy}>
                取消
              </Button>
              <Button
                variant={dialog.type === 'delete' ? 'danger' : 'accent'}
                disabled={busy || (dialog.type === 'create' && !dialog.name.trim())}
                onClick={() => void submitDialog()}
              >
                {busy
                  ? '处理中'
                  : dialog.type === 'delete'
                    ? '移到最近删除'
                    : dialog.type === 'create'
                      ? '创建'
                      : '确定'}
              </Button>
            </footer>
          </div>
        </Modal>
      )}
    </div>
  );
}

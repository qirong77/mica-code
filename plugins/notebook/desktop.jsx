import { cloneElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  FilePlus2,
  FileText,
  Focus,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Menu,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Plus,
  Presentation,
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
import { createNotebookController, NotebookConflictError } from './controller';
import {
  createNode,
  createNodeId,
  emptyIndex,
  flattenVisibleTree,
  moveNode,
  renameNode,
  restoreNode,
  trashNode,
} from './model';
import { createEditorBridge } from './bridge';
import { createNotebookDraft, createNotebookWriter, updateNotebookDraft } from './writer';
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
function MenuRow({ action, label, Icon, variant = 'ghost', onSelect }) {
  return (
    <MenuItem
      danger={variant === 'danger-ghost'}
      icon={<Icon size={16} strokeWidth={1.7} />}
      onClick={() => onSelect(action)}
    >
      <span className="mica-menu-label">{label}</span>
    </MenuItem>
  );
}

/**
 * 笔记的「更多」菜单：重命名 / 移动 / 删除。目录行与顶栏共用。
 *
 * ArcoPopover 负责定位与点外关闭；菜单行、键盘导航与 Esc 交给共享菜单。
 */
function PopoverMenu({ open, onOpen, onClose, label, position = 'br', trigger, children }) {
  const anchor = useRef(null);
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
        <MenuList
          aria-label={label}
          autoFocus
          onClose={() => {
            onClose();
            anchor.current?.querySelector('button')?.focus({ preventScroll: true });
          }}
        >
          {children}
        </MenuList>
      }
    >
      {cloneElement(trigger, { ref: anchor })}
    </ArcoPopover>
  );
}

function NoteMenu({ node, open, onOpen, onClose, onAction, extraRows, trigger, position = 'br' }) {
  return (
    <PopoverMenu
      open={open}
      onOpen={onOpen}
      onClose={onClose}
      label={`${node.title} 的操作`}
      position={position}
      trigger={trigger}
    >
      {extraRows && (
        <>
          {extraRows}
          <MenuSeparator />
        </>
      )}
      <MenuRow action="rename" label="重命名" Icon={Pencil} onSelect={onAction} />
      <MenuRow action="move" label="移动到…" Icon={FolderInput} onSelect={onAction} />
      <MenuSeparator />
      <MenuRow action="delete" label="移到最近删除" Icon={Trash2} variant="danger-ghost" onSelect={onAction} />
    </PopoverMenu>
  );
}

/** 所有笔记在插件数据目录内，不属于会话、工作区或浏览器 localStorage。 */
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
  const [newMenu, setNewMenu] = useState(false);
  const [railOpen, setRailOpen] = useState(() => !window.matchMedia('(max-width: 760px)').matches);
  const [outlineOpen, setOutlineOpen] = useState(() => !window.matchMedia('(max-width: 1100px)').matches);
  const [layout, setLayout] = useState(() => ({
    mobile: window.innerWidth <= 760,
    overlay: window.innerWidth <= 1100,
  }));
  const [focused, setFocused] = useState(false);
  const [outline, setOutline] = useState(emptyOutline);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [frameState, setFrameState] = useState('loading');
  const [frameKey, setFrameKey] = useState(0);
  const iframe = useRef(null);
  const pageRoot = useRef(null);
  const rail = useRef(null);
  const outlinePanel = useRef(null);
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
  const mounted = useRef(true);
  const loadedNote = useRef(null);
  const tree = useRef(null);
  const actions = useRef({});
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
  const active = index.nodes.find((node) => node.id === activeId && !node.trashedAt);
  const selected = index.nodes.find((node) => node.id === selectedId);
  const visible = useMemo(
    () => flattenVisibleTree(index, { expanded, query, showTrash: trash }),
    [index, expanded, query, trash],
  );
  const railOverlay = layout.mobile && railOpen && !focused;
  const outlineOverlay = layout.overlay && outlineOpen && !focused && !!active;

  const save = useCallback(
    async (target = current.current) => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      try {
        await writer.save(target);
        return true;
      } catch (cause) {
        if (mounted.current && current.current === target) setError(message(cause));
        return false;
      }
    },
    [writer],
  );

  const acceptChange = useCallback(
    (id, document) => {
      const draft = drafts.current.get(id);
      if (!draft || current.current !== draft) return;
      uncollected.current = false;
      updateNotebookDraft(draft, document);
      if (!draft.dirty) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void save(draft);
      }, 650);
    },
    [save],
  );

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
        await instance.load(draft.id, draft.document);
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
    [lifecycle],
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
            return draft?.dirty ? draft : createNotebookDraft(id, await controller.readDocument(id));
          },
          async (draft) => {
            if (!draft) return;
            drafts.current.set(id, draft);
            current.current = draft;
            setActiveId(id);
            setSelectedId(id);
            setError('');
            setOutline(emptyOutline());
            loadedNote.current = null;
            await loadEditor(draft);
            if (layoutRef.current.mobile) setRailOpen(false);
          },
        );
      } catch (cause) {
        setError(message(cause));
      } finally {
        setBusy(false);
      }
    },
    [controller, flush, loadEditor, lifecycle],
  );

  actions.current = { flush, openNote, save, loadEditor };

  useEffect(() => {
    let alive = true;
    mounted.current = true;
    void controller
      .loadIndex()
      .then(async (result) => {
        if (!alive) return;
        setExpanded(new Set(result.nodes.filter((node) => node.kind === 'folder').map((node) => node.id)));
        setLoaded(true);
        const first = result.nodes.find((node) => node.kind === 'note' && !node.trashedAt);
        if (first) await actions.current.openNote(first.id);
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
      void actions.current.save();
    };
  }, [controller]);

  useEffect(() => {
    ready.current = false;
    loadedNote.current = null;
    setFrameState('loading');
    const instance = createEditorBridge({
      token,
      target: () => iframe.current?.contentWindow ?? null,
      onReady() {
        ready.current = true;
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
      onChange: acceptChange,
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
    };
  }, [token, acceptChange, lifecycle]);

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
      const next = { mobile: entry.contentRect.width <= 760, overlay: entry.contentRect.width <= 1100 };
      const previous = layoutRef.current;
      if (previous.mobile === next.mobile && previous.overlay === next.overlay) return;
      layoutRef.current = next;
      setLayout(next);
      if (next.mobile && !previous.mobile) setRailOpen(false);
      if (next.overlay && !previous.overlay) setOutlineOpen(false);
    });
    if (pageRoot.current) observer.observe(pageRoot.current);
    return () => observer.disconnect();
  }, []);

  // 顶栏与编辑器工具栏是同一行：把两侧实际占的宽度告诉 iframe，让它给工具栏空出同样的位置，
  // 只靠 CSS 猜宽度会在标题变长或增删按钮时互相压住。
  useEffect(() => {
    const send = () => {
      const mobile = layoutRef.current.mobile;
      const height = barLead.current?.offsetHeight || barActions.current?.offsetHeight || 0;
      bridge.current?.layout({
        left: mobile ? 0 : (barLead.current?.offsetWidth ?? 0),
        right: mobile ? 0 : (barActions.current?.offsetWidth ?? 0),
        height: mobile ? 0 : height,
      });
    };
    send();
    syncLayout.current = send;
    const observer = new ResizeObserver(send);
    for (const node of [barLead.current, barActions.current]) if (node) observer.observe(node);
    return () => {
      observer.disconnect();
      syncLayout.current = () => {};
    };
  }, [activeId, frameKey, focused, layout.mobile, railOpen]);

  useEffect(() => {
    const escape = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || dialog || menu || newMenu) return;
      if (focused) setFocused(false);
      else if (layout.overlay && outlineOpen) setOutlineOpen(false);
      else if (layout.mobile && railOpen) setRailOpen(false);
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [focused, dialog, menu, newMenu, outlineOpen, railOpen, layout]);

  // iframe 内的点击不冒泡到宿主；焦点进入编辑器时也要收起宿主的菜单。
  useEffect(() => {
    if (!menu && !newMenu) return;
    const closeMenus = () => {
      setMenu(null);
      setNewMenu(false);
    };
    window.addEventListener('blur', closeMenus);
    return () => window.removeEventListener('blur', closeMenus);
  }, [menu, newMenu]);

  useEffect(() => {
    const panel = railOverlay ? rail.current : outlineOverlay ? outlinePanel.current : null;
    if (!panel) return;
    const previous = document.activeElement;
    panel.querySelector('button:not(:disabled), input:not(:disabled)')?.focus({ preventScroll: true });
    return () => {
      queueMicrotask(() => {
        if (previous instanceof HTMLElement && previous.isConnected && !previous.closest('[inert]'))
          previous.focus({ preventScroll: true });
      });
    };
  }, [railOverlay, outlineOverlay]);

  const jump = (target) => {
    if (!activeId || !ready.current || loadedNote.current !== activeId) return;
    bridge.current?.navigate(activeId, target);
    if (layoutRef.current.overlay) setOutlineOpen(false);
  };

  const toggleFolder = (id) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
          drafts.current.set(draft.id, latest);
          current.current = latest;
          await loadEditor(latest);
          setError('');
          setDialog(null);
        },
      );
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const create = (kind) =>
    setDialog({
      type: 'create',
      id: createNodeId(),
      now: new Date().toISOString(),
      kind,
      title: kind === 'folder' ? '新建文件夹' : '新建笔记',
      name: '',
      parentId: parentForNew,
    });
  const edit = (node) => setDialog({ type: 'rename', node, title: '重命名', name: node.title });
  const downloadActive = async () => {
    setMenu(null);
    const note = active;
    if (!note) return;
    if (ready.current && loadedNote.current === note.id) {
      try {
        const value = await bridge.current.flush();
        acceptChange(value.noteId, value.document);
      } catch (cause) {
        setError(message(cause));
      }
    }
    if (current.current) download(current.current.document, note.title);
  };
  const runAction = (node, action) => {
    setMenu(null);
    if (action === 'rename') edit(node);
    else if (action === 'move') setDialog({ type: 'move', title: '移动到', node, parentId: node.parentId || '' });
    else setDialog({ type: 'delete', title: '移到最近删除', node });
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
      }
    } else if (value.type === 'move') {
      const now = new Date().toISOString();
      if (!(await mutate((latest) => moveNode(latest, value.node.id, value.parentId || null, now)))) return;
    } else if (value.type === 'rename') {
      const now = new Date().toISOString();
      if (!(await mutate((latest) => renameNode(latest, value.node.id, value.name, now)))) return;
    } else {
      if (!(await flush())) return;
      const { id, now } = value;
      const result = await mutate((latest) =>
        latest.nodes.some((node) => node.id === id)
          ? latest
          : createNode(latest, { id, now, kind: value.kind, title: value.name, parentId: value.parentId }),
      );
      if (!result || lifecycle.closing) return;
      if (value.parentId) setExpanded((previous) => new Set([...previous, value.parentId]));
      if (value.kind === 'folder') {
        setSelectedId(id);
        setExpanded((previous) => new Set([...previous, id]));
      } else {
        await openNote(id);
      }
      setTrash(false);
    }
    setDialog(null);
  };

  const selectRow = (node) => {
    if (lifecycle.closing) return;
    setSelectedId(node.id);
    if (trash) return;
    if (node.kind === 'folder') toggleFolder(node.id);
    else void openNote(node.id);
  };
  const navigateTree = (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft', 'Enter', 'F2'].includes(event.key)) return;
    if (event.target.closest('input')) return;
    const position = visible.findIndex(({ node }) => node.id === selectedId);
    const row = visible[position];
    if (event.key === 'F2' && row && !trash) {
      event.preventDefault();
      edit(row.node);
      return;
    }
    if (event.key === 'Enter' && row) {
      event.preventDefault();
      selectRow(row.node);
      return;
    }
    let target;
    if (event.key === 'ArrowDown') target = visible[Math.min(visible.length - 1, position + 1)];
    if (event.key === 'ArrowUp') target = visible[Math.max(0, position - 1)];
    if (event.key === 'Home') target = visible[0];
    if (event.key === 'End') target = visible.at(-1);
    if (event.key === 'ArrowRight' && row?.node.kind === 'folder') {
      if (!expanded.has(row.node.id)) toggleFolder(row.node.id);
      else target = visible[position + 1];
    }
    if (event.key === 'ArrowLeft' && row) {
      if (expanded.has(row.node.id)) toggleFolder(row.node.id);
      else target = visible.find(({ node }) => node.id === row.node.parentId);
    }
    if (target) {
      setSelectedId(target.node.id);
      requestAnimationFrame(() => tree.current?.querySelector(`[data-node-id="${target.node.id}"]`)?.focus());
    }
    event.preventDefault();
  };

  const path = [];
  let ancestor = active;
  while (ancestor) {
    path.unshift(ancestor.title);
    ancestor = index.nodes.find((node) => node.id === ancestor.parentId);
  }
  const folders = index.nodes.filter((node) => node.kind === 'folder' && !node.trashedAt);
  const forbidden = new Set(dialog?.node ? [dialog.node.id] : []);
  for (let i = 0; i < folders.length; i++)
    for (const folder of folders) if (forbidden.has(folder.parentId)) forbidden.add(folder.id);

  return (
    <div ref={pageRoot} className={`notebook-page ${railOpen ? 'is-rail-open' : ''} ${focused ? 'is-focused' : ''}`}>
      <div className="notebook-layout">
        <aside ref={rail} className="notebook-rail" aria-label="笔记目录" inert={outlineOverlay}>
          <div className="notebook-rail-title">
            <span className="notebook-book-icon">
              <BookOpen size={15} strokeWidth={1.6} />
            </span>
            <strong>我的笔记</strong>
            <Button
              variant="ghost"
              icon={<PanelLeftClose size={15} />}
              title="收起目录"
              aria-label="收起目录"
              onClick={() => setRailOpen(false)}
            />
          </div>
          {/* 搜索与新建共用一栏：左边找笔记，右边就地新建，不再各占一行。 */}
          <div className="notebook-rail-tools">
            <div className="notebook-search">
              <Input
                value={query}
                onChange={setQuery}
                placeholder="搜索笔记"
                aria-label="搜索笔记"
                prefix={<Search size={14} strokeWidth={1.7} />}
                allowClear
              />
            </div>
            <PopoverMenu
              open={newMenu}
              onOpen={() => {
                setMenu(null);
                setNewMenu(true);
              }}
              onClose={() => setNewMenu(false)}
              label="新建"
              position="bl"
              trigger={
                <span className="notebook-rail-add-anchor">
                  <Button
                    variant="ghost"
                    className="notebook-rail-add"
                    icon={<Plus size={16} />}
                    title="新建笔记或文件夹"
                    aria-label="新建"
                    pressed={newMenu}
                    disabled={!loaded || busy || trash}
                    onClick={() => {}}
                  />
                </span>
              }
            >
              <MenuRow
                action="note"
                label="新建笔记"
                Icon={FilePlus2}
                onSelect={(kind) => {
                  setNewMenu(false);
                  create(kind);
                }}
              />
              <MenuRow
                action="folder"
                label="新建文件夹"
                Icon={FolderPlus}
                onSelect={(kind) => {
                  setNewMenu(false);
                  create(kind);
                }}
              />
            </PopoverMenu>
          </div>
          {trash && (
            <div className="notebook-tree-heading">
              <span>
                最近删除<small>{index.nodes.filter((node) => node.trashedAt).length}</small>
              </span>
            </div>
          )}
          <div
            className="notebook-tree"
            role="tree"
            aria-label={trash ? '最近删除' : '笔记目录树'}
            ref={tree}
            onKeyDown={navigateTree}
          >
            {!loaded ? (
              <div className="notebook-tree-skeleton">
                <i />
                <i />
                <i />
              </div>
            ) : visible.length ? (
              visible.map(({ node, depth }) => (
                <div
                  className={`notebook-tree-entry ${node.id === selectedId ? 'is-selected' : ''} ${node.id === activeId ? 'is-active' : ''}`}
                  key={node.id}
                  style={{ '--depth': depth }}
                >
                  <button
                    type="button"
                    role="treeitem"
                    aria-selected={node.id === selectedId}
                    aria-expanded={node.kind === 'folder' ? expanded.has(node.id) : undefined}
                    aria-level={depth + 1}
                    data-node-id={node.id}
                    tabIndex={node.id === selectedId || (!selectedId && visible[0]?.node.id === node.id) ? 0 : -1}
                    title={node.title}
                    className="notebook-tree-row"
                    onClick={() => selectRow(node)}
                  >
                    <span className="notebook-tree-chevron">
                      {node.kind === 'folder' ? (
                        expanded.has(node.id) ? (
                          <ChevronDown size={12} />
                        ) : (
                          <ChevronRight size={12} />
                        )
                      ) : null}
                    </span>
                    {node.kind === 'folder' ? (
                      expanded.has(node.id) ? (
                        <FolderOpen size={15} />
                      ) : (
                        <Folder size={15} />
                      )
                    ) : (
                      <FileText size={15} />
                    )}
                    <span>{node.title}</span>
                  </button>
                  {trash ? (
                    <Button
                      variant="ghost"
                      icon={<Undo2 size={13} />}
                      title="恢复"
                      aria-label={`恢复：${node.title}`}
                      className="notebook-row-actions"
                      onClick={() => {
                        let root = node;
                        while (index.nodes.find((item) => item.id === root.parentId)?.trashedAt)
                          root = index.nodes.find((item) => item.id === root.parentId);
                        const now = new Date().toISOString();
                        void mutate((latest) => restoreNode(latest, root.id, now));
                      }}
                    />
                  ) : (
                    <NoteMenu
                      node={node}
                      open={menu?.id === node.id && menu.source === 'row'}
                      onOpen={() => {
                        setNewMenu(false);
                        setSelectedId(node.id);
                        setMenu({ id: node.id, source: 'row' });
                      }}
                      onClose={() => setMenu(null)}
                      onAction={(action) => runAction(node, action)}
                      trigger={
                        <span className="notebook-row-actions">
                          <Button
                            variant="ghost"
                            icon={<MoreHorizontal size={14} />}
                            title="更多操作"
                            aria-label={`更多操作：${node.title}`}
                            pressed={menu?.id === node.id && menu.source === 'row'}
                            onClick={() => setSelectedId(node.id)}
                          />
                        </span>
                      }
                    />
                  )}
                </div>
              ))
            ) : (
              <div className="notebook-tree-empty">
                {query ? '没有匹配的笔记' : trash ? '还没有删除的内容' : '还没有笔记'}
                {!query && !trash && (
                  <Button variant="ghost" onClick={() => create('note')}>
                    创建第一篇笔记
                  </Button>
                )}
              </div>
            )}
          </div>
          <div className="notebook-rail-footer">
            <span title="笔记自动保存在本机">
              <ShieldCheck size={12} />
              本地存储
            </span>
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
        </aside>
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
            <div className={`notebook-editor-area ${active ? 'has-note' : ''}`} inert={outlineOverlay}>
              {/* 顶栏与编辑器工具栏是同一条操作栏：只有目录收起时才在左边出现目录开关与位置，
                  右边常驻保存状态与文档操作；工具栏按这两段的实测宽度让位。 */}
              <div className="notebook-bar">
                {(focused || !railOpen) && (
                  <div className="notebook-bar-lead" ref={barLead}>
                    <Button
                      variant="ghost"
                      icon={<Menu size={16} />}
                      title={focused ? '显示目录并退出专注' : '展开目录'}
                      aria-label={focused ? '显示目录并退出专注' : '展开目录'}
                      onClick={() => {
                        setFocused(false);
                        setRailOpen(true);
                        if (layoutRef.current.overlay) setOutlineOpen(false);
                      }}
                    />
                    {active && (
                      <span className="notebook-breadcrumb" title={path.join(' / ')}>
                        {path.slice(0, -1).join(' / ') || '我的笔记'}
                      </span>
                    )}
                  </div>
                )}
                {active && (
                  <div className="notebook-bar-actions" ref={barActions}>
                    <Button
                      variant="ghost"
                      icon={<Presentation size={16} strokeWidth={1.6} />}
                      title="演示"
                      aria-label="演示"
                      disabled={busy || frameState !== 'ready'}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => bridge.current?.action(active.id, 'present')}
                    />
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
                      onOpen={() => {
                        setNewMenu(false);
                        setMenu({ id: active.id, source: 'header' });
                      }}
                      onClose={() => setMenu(null)}
                      onAction={(action) => runAction(active, action)}
                      position="bl"
                      extraRows={
                        <>
                          <MenuRow
                            action="download"
                            label="下载 JSON"
                            Icon={Download}
                            onSelect={() => void downloadActive()}
                          />
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
                            icon={<MoreHorizontal size={16} />}
                            title="笔记操作"
                            aria-label="笔记操作"
                            pressed={menu?.id === active.id && menu.source === 'header'}
                            onClick={() => {}}
                          />
                        </span>
                      }
                    />
                  </div>
                )}
              </div>
              <iframe
                key={frameKey}
                ref={iframe}
                className="notebook-editor-frame"
                title="笔记富文本编辑器"
                src={`/editor/index.html#${token}`}
                sandbox="allow-scripts allow-downloads allow-popups"
                allow="clipboard-read; clipboard-write; fullscreen"
                allowFullScreen
              />
              {!active ? (
                <div className="notebook-welcome">
                  <span className="notebook-welcome-icon">
                    <BookOpen size={31} strokeWidth={1.5} />
                  </span>
                  <h1>留住每一个想法</h1>
                  <p>
                    一处安静的空间，记录文字、表格和灵感。
                    <br />
                    所有笔记自动保存到本机。
                  </p>
                  <Button
                    variant="accent"
                    icon={<Plus size={16} />}
                    disabled={!loaded || busy}
                    onClick={() => create('note')}
                  >
                    新建笔记
                  </Button>
                  <div className="notebook-feature-hints">
                    <span>丰富排版</span>
                    <span>灵活表格</span>
                    <span>图片与公式</span>
                  </div>
                </div>
              ) : frameState === 'loading' ? (
                <div className="notebook-editor-skeleton">
                  <i />
                  <i />
                  <i />
                  <i />
                  <span>首次打开将从 CDN 加载编辑器，笔记内容不会上传。</span>
                </div>
              ) : frameState === 'error' ? (
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
            {active && outlineOpen && !focused && (
              <>
                <button
                  type="button"
                  className="notebook-outline-mask"
                  tabIndex={-1}
                  aria-label="关闭大纲浮层"
                  onClick={() => setOutlineOpen(false)}
                />
                <aside ref={outlinePanel} className="notebook-outline" aria-label="文档大纲">
                  <header>
                    <strong>大纲</strong>
                    <Button
                      variant="ghost"
                      size="compact"
                      className="notebook-outline-eye"
                      icon={<EyeOff size={14} />}
                      title="收起大纲"
                      aria-label="收起大纲"
                      onClick={() => setOutlineOpen(false)}
                    />
                  </header>
                  <nav className="notebook-outline-list" aria-label="当前笔记的标题">
                    {!outline.items.length && (
                      <p className="notebook-outline-empty">
                        {frameState !== 'ready' ? '正在读取文档结构…' : '添加标题后，文档结构会显示在这里。'}
                      </p>
                    )}
                    {outline.items.map((item) => (
                      <Button
                        key={item.key}
                        variant="ghost"
                        fullWidth
                        className={`mica-arco-row notebook-outline-entry ${item.key === outline.activeKey ? 'is-active' : ''}`}
                        style={{ '--heading-level': item.level }}
                        aria-current={item.key === outline.activeKey ? 'location' : undefined}
                        title={item.text || '未命名标题'}
                        disabled={busy}
                        onClick={() => jump({ heading: item.key })}
                      >
                        <span>{item.text.replace(/^\d+\s*[·.、]\s*/, '') || '未命名标题'}</span>
                      </Button>
                    ))}
                  </nav>
                </aside>
              </>
            )}
            {/* 收起态的刻度条：标题按顺序标在右侧，当前标题高亮，悬停时出现眼睛按钮展开。 */}
            {active && !outlineOpen && !focused && outline.items.length > 0 && (
              <aside className="notebook-outline-rail" aria-label="文档大纲（已收起）">
                <Button
                  variant="ghost"
                  className="notebook-outline-eye"
                  icon={<Eye size={14} />}
                  title="展开大纲"
                  aria-label="展开大纲"
                  onClick={() => {
                    setFocused(false);
                    setOutlineOpen(true);
                  }}
                />
                <div className="notebook-outline-track">
                  {outline.items.map((item, index) => (
                    <button
                      key={item.key}
                      type="button"
                      className={`notebook-outline-mark ${item.key === outline.activeKey ? 'is-active' : ''}`}
                      style={{ top: `${((index + 0.5) / outline.items.length) * 100}%`, '--heading-level': item.level }}
                      title={item.text || '未命名标题'}
                      aria-label={item.text || '未命名标题'}
                      aria-current={item.key === outline.activeKey ? 'location' : undefined}
                      disabled={busy}
                      onClick={() => jump({ heading: item.key })}
                    />
                  ))}
                </div>
              </aside>
            )}
          </div>
        </main>
      </div>
      {dialog && (
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
                  options={[
                    { value: '', label: '我的笔记（根目录）' },
                    ...folders
                      .filter((folder) => !forbidden.has(folder.id))
                      .map((folder) => ({ value: folder.id, label: folder.title })),
                  ]}
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
                disabled={busy || (['create', 'rename'].includes(dialog.type) && !dialog.name.trim())}
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

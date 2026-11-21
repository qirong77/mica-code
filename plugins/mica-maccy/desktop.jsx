import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ClipboardList,
  ClipboardPaste,
  Copy,
  FileText,
  Files,
  Image as ImageIcon,
  Loader2,
  Pencil,
  Pin,
  Search,
  Trash2,
  Type,
  X,
} from 'lucide-react';
import { ArcoAction, Button, Input, MenuItem, MenuList, MenuSeparator, Modal, Segmented } from '@mica-config-ui/web';
import './desktop.css';

/**
 * Maccy 风格的剪贴板历史浮窗。
 *
 * 这一层只有界面与「按一下就做什么」的意图：读历史、写回系统剪贴板、原生粘贴、固定、
 * 重命名与清理全在同目录的 `launcher.js`。所以这里不做乐观更新——动作成功后按后端返回
 * 的当前状态重取一次列表，界面永远显示后端说的那一份事实。
 *
 * 界面上不放成排的按钮：点一下条目就是「用它」（默认复制，⌥ 点粘贴），右侧同步显示全文。
 * 固定 / 重命名 / 删除这类整理动作在右键菜单里，键盘上还有 Maccy 的组合键；清理交给后台
 * 的 31 天保留策略，不必每次手动清。
 */

/** 浮窗尺寸由清单声明，卡片宽度为其它入口形态兜底。 */
export const card = { width: 560 };

export const FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'pinned', label: '固定' },
  { value: 'text', label: '文本' },
  { value: 'image', label: '图片' },
  { value: 'files', label: '文件' },
];

const KIND_META = {
  text: { label: '文本', icon: FileText },
  image: { label: '图片', icon: ImageIcon },
  files: { label: '文件', icon: Files },
};

const POLL_INTERVAL_MS = 1500;
const SEARCH_DELAY_MS = 180;
const NOTICE_TIMEOUT_MS = 8000;
const DETAIL_CACHE_LIMIT = 40;

/**
 * @typedef {{ id: string, title: string, kind: string, textPreview?: string,
 * source?: {name?: string, bundleId?: string}, pinned?: boolean, pinKey?: string,
 * createdAt?: number, lastCopiedAt?: number, copyCount?: number, bytes?: number }} ClipboardItem
 * @typedef {{ id?: string, item?: ClipboardItem, text?: string, previewImage?: string | null,
 * files?: string[], types?: string[] }} ClipboardDetail
 */

/** 预览只接受内联的光栅图片：后端下发的 `data:image/png;base64,…`。 */
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 后端约定「出错就抛」或回 `{ ok: false, error }`，两种都在这里归一。
 * 启动器动作失败时必须让用户看见原因：浮窗是唯一能看到它的地方。
 */
function checkResult(result) {
  if (result === false || result?.ok === false) {
    throw new Error(result?.error || '操作未完成，请重试。');
  }
  return result;
}

/** 安全的内联图片地址：不是 `data:image/<光栅>;base64,…` 就不画，避免把页面交给任意 URL。 */
export function safeImageSource(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return DATA_IMAGE.test(text) ? text : '';
}

/** A failed image keeps the same box and falls back to its type icon. */
export function ClipboardThumbnail({ source = '' }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [source]);
  const image = safeImageSource(source);
  return (
    <span className="maccy-thumbnail">
      {image && !failed ? (
        <img src={image} alt="图片缩略图" onError={() => setFailed(true)} />
      ) : (
        <ImageIcon size={18} aria-label="图片" />
      )}
    </span>
  );
}

/** The preview keeps its copy actions available when decoding an image fails. */
export function ClipboardImagePreview({ source = '', loading = false, loaded = false }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [source]);
  const image = safeImageSource(source);
  return image && !failed ? (
    <img className="maccy-preview-image" src={image} alt="剪贴板图片预览" onError={() => setFailed(true)} />
  ) : (
    <p className="maccy-preview-placeholder">
      {failed
        ? '无法显示图片预览，仍可复制原内容。'
        : loaded
          ? '这张图片没有可用的预览。'
          : loading
            ? '正在生成预览…'
            : '暂无预览'}
    </p>
  );
}

/** Fetch small cached thumbnails only for rows near the visible part of the list. */
function useListThumbnails(launcher, items, listRef) {
  const cache = useRef(new Map());
  const [, redraw] = useState(0);
  useEffect(() => {
    const root = listRef.current;
    if (!root || typeof launcher?.request !== 'function') return undefined;
    let cancelled = false;
    let timer;
    let reading = false;
    const pending = new Set();
    const load = async () => {
      if (cancelled || reading || !pending.size) return;
      reading = true;
      const ids = [...pending].slice(0, 24);
      for (const id of ids) pending.delete(id);
      try {
        const value = checkResult(await launcher.request('thumbnails', { ids }));
        if (cancelled) return;
        for (const id of ids) cache.current.set(id, safeImageSource(value?.images?.[id]));
        while (cache.current.size > 240) cache.current.delete(cache.current.keys().next().value);
        redraw((value) => value + 1);
      } catch {
        /* Keep the fallback icon; a broken thumbnail cannot block copying. */
      } finally {
        reading = false;
        if (!cancelled && pending.size) timer = setTimeout(load, 40);
      }
    };
    const queue = (id) => {
      if (!id || cache.current.has(id)) return;
      pending.add(id);
      clearTimeout(timer);
      timer = setTimeout(load, 40);
    };
    const rows = [...root.querySelectorAll('[data-image-id]')];
    let observer;
    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) if (entry.isIntersecting) queue(entry.target.dataset.imageId);
        },
        { root, rootMargin: '100px' },
      );
      for (const row of rows) observer.observe(row);
    } else for (const row of rows.slice(0, 24)) queue(row.dataset.imageId);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      observer?.disconnect();
    };
  }, [launcher, items, listRef]);
  return cache.current;
}

export function formatBytes(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/** 列表里的时间只回答「多近」：一分钟内、一小时内按相对时间，今天给时刻，更早给日期。 */
export function formatWhen(value, now = Date.now()) {
  const time = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  if (!Number.isFinite(time)) return '';
  const diff = Math.max(0, now - time);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const date = new Date(time);
  if (new Date(now).toDateString() === date.toDateString()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

const MODIFIER_SYMBOLS = {
  commandorcontrol: '⌘',
  cmdorctrl: '⌘',
  command: '⌘',
  cmd: '⌘',
  meta: '⌘',
  shift: '⇧',
  alt: '⌥',
  option: '⌥',
  control: '⌃',
  ctrl: '⌃',
};

/** Apple 的按键书写顺序：⌃⌥⇧⌘，所以 `CommandOrControl+Shift+C` 显示成 ⇧⌘C。 */
const MODIFIER_RANK = { '⌃': 0, '⌥': 1, '⇧': 2, '⌘': 3 };

export function formatShortcut(value) {
  const parts = String(value || '')
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return '';
  const modifiers = parts
    .slice(0, -1)
    .map((part) => MODIFIER_SYMBOLS[part.toLowerCase()] ?? part)
    .sort((left, right) => (MODIFIER_RANK[left] ?? 9) - (MODIFIER_RANK[right] ?? 9));
  const key = parts[parts.length - 1];
  return `${modifiers.join('')}${key.length === 1 ? key.toUpperCase() : key}`;
}

function digitFromEvent(input) {
  const code = /^Digit([1-9])$/.exec(String(input.code || ''));
  if (code) return Number(code[1]);
  const key = /^([1-9])$/.exec(String(input.key || ''));
  return key ? Number(key[1]) : 0;
}

/** ⌥ 组合键的 `key` 在 macOS 上是重音字符（⌥P → π），所以字母一律先看 `code`。 */
function letterFromEvent(input) {
  const code = /^Key([A-Z])$/.exec(String(input.code || ''));
  if (code) return code[1].toLowerCase();
  return /^[a-z]$/i.test(String(input.key || '')) ? String(input.key).toLowerCase() : '';
}

/**
 * 一次按键要做什么——纯函数，界面状态一概不碰，方便钉住快捷键的含义。
 *
 * 返回 `null` 表示「这一下不归浮窗管」（继续输入、交给输入框的光标操作等）：
 * `{ type: 'move', to }` / `{ type: 'select', index?|id?, mode }` / `{ type: 'pin' }` /
 * `{ type: 'delete' }` / `{ type: 'clear' }` / `{ type: 'configure' }` / `{ type: 'escape' }`。
 */
export function resolveShortcut(input, { pinnedKeys } = {}) {
  if (!input || input.composing) return null;
  const mod = Boolean(input.metaKey || input.ctrlKey);
  const alt = Boolean(input.altKey);
  const shift = Boolean(input.shiftKey);
  const key = String(input.key || '');
  const code = String(input.code || '');
  const backspace = key === 'Backspace' || key === 'Delete' || code === 'Backspace' || code === 'Delete';
  const digit = digitFromEvent(input);
  const letter = letterFromEvent(input);

  if (key === 'Escape' && !mod && !alt) return { type: 'escape' };
  // 清理走确认弹窗：⇧⌥⌘⌫ 只是把「清空全部」先选中，真正的执行仍要用户点一下。
  if (mod && alt && backspace) return { type: 'clear', includePinned: shift };
  if (mod && !alt && (code === 'Comma' || key === ',')) return { type: 'configure' };
  if (mod && !alt && digit) return { type: 'select', index: digit - 1, mode: 'copy' };
  if (alt && !mod && digit) return { type: 'select', index: digit - 1, mode: shift ? 'plain' : 'paste' };
  if (alt && !mod && backspace) return { type: 'delete' };
  if (alt && !mod && !shift && letter === 'p') return { type: 'pin' };
  if (alt && !mod && !shift && letter) {
    const id = pinnedKeys?.get?.(letter);
    if (id) return { type: 'select', id, mode: 'copy' };
  }
  if (key === 'Enter' && !mod) return { type: 'select', mode: alt ? (shift ? 'plain' : 'paste') : 'default' };
  if (!mod && !alt && !shift) {
    if (key === 'ArrowDown') return { type: 'move', to: 'next' };
    if (key === 'ArrowUp') return { type: 'move', to: 'prev' };
    if (key === 'PageDown') return { type: 'move', to: 'pageNext' };
    if (key === 'PageUp') return { type: 'move', to: 'pagePrev' };
    if (key === 'Home') return { type: 'move', to: 'first' };
    if (key === 'End') return { type: 'move', to: 'last' };
  }
  return null;
}

/**
 * 系统层面的阻塞问题只留一条：原生回贴不可用、没有辅助功能权限、系统快捷键没注册。
 * 都能点进去修，所以文案里说清缺什么，而不是把状态码丢给用户。
 */
export function systemNotice({ native, status } = {}) {
  if (native?.supported === false) {
    return {
      key: 'native',
      tone: 'warn',
      text: native.error || '当前环境不能写回系统剪贴板，只能查看历史。',
    };
  }
  if (native?.accessibility === false) {
    return {
      key: 'accessibility',
      tone: 'warn',
      text: native.error || '没有辅助功能权限，选中后不会自动粘贴。',
      action: 'native',
    };
  }
  // 运行时故障（辅助进程崩了、系统调用失败）也要说出来，否则界面看着一切正常、复制却没反应。
  if (native?.error) {
    return { key: 'native-error', tone: 'warn', text: native.error, action: 'native' };
  }
  if (status && status.registered === false) {
    const shortcut = status.shortcut ? `（${status.shortcut}）` : '';
    return {
      key: 'shortcut',
      tone: 'warn',
      text: `系统快捷键未注册${shortcut}${status.error ? `：${status.error}` : '，可按菜单栏图标唤出。'}`,
      action: 'retry',
    };
  }
  return null;
}

function kindLabel(kind) {
  return KIND_META[kind]?.label ?? '条目';
}

function KindIcon({ kind, size = 14 }) {
  const Icon = KIND_META[kind]?.icon ?? ClipboardList;
  return <Icon size={size} aria-hidden="true" />;
}

function itemLabel(item) {
  return item?.title || item?.textPreview || kindLabel(item?.kind);
}

function itemMeta(item, now) {
  const source = item?.source?.name || '';
  const when = formatWhen(item?.lastCopiedAt ?? item?.createdAt, now);
  return [source, when].filter(Boolean).join(' · ');
}

function countText({ loading, total, pinnedCount, query }) {
  if (loading) return '正在载入…';
  if (!total) return query ? '没有匹配' : '还没有条目';
  return `${total} 条 · ${pinnedCount} 个固定`;
}

/**
 * 列表为空时解释搜索、筛选与暂停记录。
 * @param {{query?: string, filter?: string, paused?: boolean, onClearQuery?: () => void,
 * onShowAll?: () => void, onResume?: () => void, onConfigure?: () => void}} props
 */
export function ClipboardEmpty({
  query = '',
  filter = 'all',
  paused = false,
  onClearQuery,
  onShowAll,
  onResume,
  onConfigure,
}) {
  let title = '还没有复制过任何内容';
  let description = '在任意应用里复制文本、图片或文件，就会出现在这里。';
  let action = onConfigure ? { label: '打开设置', run: onConfigure } : null;
  if (query.trim()) {
    title = `没有找到「${query.trim()}」`;
    description = '换个关键词试试，搜索范围与排序方式在设置里调整。';
    action = onClearQuery ? { label: '清除搜索', run: onClearQuery } : null;
  } else if (filter !== 'all') {
    const label = FILTERS.find((entry) => entry.value === filter)?.label ?? '';
    title = `还没有${label}条目`;
    description = '这个筛选下暂时是空的。';
    action = onShowAll ? { label: '查看全部', run: onShowAll } : null;
  } else if (paused) {
    title = '记录已暂停';
    description = '新复制的条目暂时不会进历史，继续记录后恢复。';
    action = onResume ? { label: '继续记录', run: onResume } : null;
  }
  return (
    <div className="maccy-empty">
      <span className="maccy-empty-icon" aria-hidden="true">
        <ClipboardList size={20} />
      </span>
      <p className="maccy-empty-title">{title}</p>
      <p className="maccy-empty-text">{description}</p>
      {action ? (
        <Button size="compact" variant="ghost" onClick={() => action.run()}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * 右侧预览：全文 / 图片 / 文件列表，末尾一行是来源与占用空间。
 * 这里只负责看清内容，不再放动作按钮——选中的那一条点一下就是「用它」。
 * @param {{item: ClipboardItem, detail?: ClipboardDetail | null, loading?: boolean, now?: number}} props
 */
export function PreviewPane({ item, detail = null, loading = false, now = Date.now() }) {
  if (!item) return null;
  const live = detail && detail.id === item.id ? detail : null;
  const text = typeof live?.text === 'string' && live.text ? live.text : item.textPreview || '';
  const image = safeImageSource(live?.previewImage);
  const files = Array.isArray(live?.files) ? live.files : [];
  const bytes = formatBytes(item.bytes);
  const pinned = Boolean(item.pinned);

  let content;
  if (item.kind === 'image') {
    content = <ClipboardImagePreview source={image} loading={loading} loaded={Boolean(live)} />;
  } else if (item.kind === 'files' && files.length) {
    content = (
      <ul className="maccy-preview-files">
        {files.map((path, index) => (
          <li key={`${path}-${index}`} title={path}>
            <Files size={12} aria-hidden="true" />
            <span>{path}</span>
          </li>
        ))}
      </ul>
    );
  } else {
    content = text ? (
      <pre className="maccy-preview-text">{text}</pre>
    ) : (
      <p className="maccy-preview-placeholder">{loading ? '正在读取内容…' : '这个条目没有可读文本。'}</p>
    );
  }

  return (
    <aside className="maccy-preview" aria-label="条目预览">
      <div className="maccy-preview-head">
        <span className="maccy-preview-kind">
          <KindIcon kind={item.kind} size={12} />
          {kindLabel(item.kind)}
        </span>
        {pinned ? (
          <span className="maccy-preview-pinned">
            <Pin size={11} aria-hidden="true" />
            已固定
          </span>
        ) : null}
        <span className="maccy-preview-time">{formatWhen(item.lastCopiedAt ?? item.createdAt, now)}</span>
      </div>
      <div className="maccy-preview-body">
        {content}
        {loading && item.kind === 'image' && image ? (
          <span className="maccy-preview-loading">正在刷新预览…</span>
        ) : null}
      </div>
      <div className="maccy-preview-meta">
        <span className="maccy-preview-source" title={item.source?.bundleId || item.source?.name || ''}>
          {item.source?.name || '未知来源'}
        </span>
        <span className="maccy-preview-stats">
          {[bytes, item.copyCount > 1 ? `用过 ${item.copyCount} 次` : ''].filter(Boolean).join(' · ')}
        </span>
      </div>
    </aside>
  );
}

export function Launcher({ api }) {
  const launcher = api?.launcher ?? null;
  const ids = useId();
  const listId = `${ids}-list`;
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const bodyRef = useRef(null);
  const mounted = useRef(false);
  const composing = useRef(false);
  const busyRef = useRef(false);
  const immediate = useRef(true);
  const detailCache = useRef(new Map());
  const detailSeq = useRef(0);
  const itemsRef = useRef([]);
  const listSignature = useRef('');
  const activeIdRef = useRef('');
  const activeRef = useRef(0);
  const queryRef = useRef('');
  const filterRef = useRef('all');
  const confirmRef = useRef(false);
  const renamingRef = useRef(null);

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [status, setStatus] = useState(null);
  const [active, setActive] = useState(0);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [renaming, setRenaming] = useState(null);
  const [confirming, setConfirming] = useState(false);
  /** 右键菜单：锚在这条条目上，坐标相对列表区。 */
  const [menu, setMenu] = useState(null);

  queryRef.current = query;
  filterRef.current = filter;
  confirmRef.current = confirming;
  renamingRef.current = renaming;

  const items = data?.items ?? [];
  const total = data?.total ?? items.length;
  const pinnedCount = data?.pinnedCount ?? 0;
  const paused = Boolean(data?.paused);
  const ignoreNext = Boolean(data?.ignoreNext);
  const settings = data?.settings ?? {};
  const showPreview = settings.showPreview !== false;
  const showFooter = settings.showFooter !== false;
  const activeItem = items[active] ?? null;
  /** 右键菜单锚定的那条：列表刷新后条目没了，菜单也就跟着消失。 */
  const menuItem = menu ? items.find((item) => item.id === menu.id) ?? null : null;
  const activeId = activeItem?.id ?? '';
  const activeDetail = detail && detail.id === activeId ? detail : null;
  const thumbnails = useListThumbnails(launcher, items, listRef);
  const failure = error || (typeof data?.error === 'string' ? data.error : '');
  const now = Date.now();
  itemsRef.current = items;
  activeRef.current = active;
  const pinnedKeys = useMemo(() => {
    const map = new Map();
    for (const item of items) {
      if (item?.pinned && item.pinKey) map.set(String(item.pinKey).toLowerCase(), item.id);
    }
    return map;
  }, [items]);

  /** 选中一律走这里：索引与「选中的是哪一条」同时更新，轮询拿回新列表时按 id 认回。 */
  const chooseIndex = useCallback((index) => {
    setActive(index);
    activeIdRef.current = itemsRef.current[index]?.id ?? '';
  }, []);

  const focusInput = useCallback((force = false) => {
    if (!force && renamingRef.current) return;
    const input = inputRef.current;
    input?.focus();
    input?.dom?.select();
  }, []);

  const refreshNow = useCallback(() => {
    immediate.current = true;
    setRevision((value) => value + 1);
  }, []);

  const readStatus = useCallback(async () => {
    if (typeof launcher?.status !== 'function') return;
    try {
      const value = checkResult(await launcher.status());
      if (mounted.current) setStatus({ native: true, ...value });
    } catch (cause) {
      if (mounted.current) setStatus({ native: true, registered: false, error: errorText(cause) });
    }
  }, [launcher]);

  const applyList = useCallback((next) => {
    const list = Array.isArray(next?.items) ? next.items : [];
    // 轮询每 1.5 秒回来一次：内容没变就不换引用，几百条历史也不用整屏重画。
    const signature = JSON.stringify([
      next?.total,
      next?.pinnedCount,
      next?.paused,
      next?.ignoreNext,
      next?.error,
      next?.native,
      next?.settings,
      list.map((item) => [
        item?.id,
        item?.lastCopiedAt,
        item?.copyCount,
        item?.pinned,
        item?.pinKey,
        item?.title,
        item?.bytes,
      ]),
    ]);
    if (signature === listSignature.current) return;
    listSignature.current = signature;
    setData({ ...next, items: list });
    setActive((previous) => {
      if (!list.length) return 0;
      const keep = activeIdRef.current;
      if (keep) {
        const found = list.findIndex((item) => item.id === keep);
        if (found >= 0) return found;
      }
      return Math.max(0, Math.min(previous, list.length - 1));
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    void readStatus();
  }, [readStatus]);

  // 列表主请求：搜索/筛选变化后短暂防抖，动作后强制立即重取。
  useEffect(() => {
    if (typeof launcher?.request !== 'function') {
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    const requestedQuery = query;
    const requestedFilter = filter;
    const delay = immediate.current ? 0 : SEARCH_DELAY_MS;
    immediate.current = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const value = checkResult(await launcher.request('list', { query: requestedQuery, filter: requestedFilter }));
        if (cancelled || requestedQuery !== queryRef.current || requestedFilter !== filterRef.current) return;
        applyList(value);
        setError('');
      } catch (cause) {
        if (!cancelled) setError(errorText(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [applyList, filter, launcher, query, revision]);

  // 轮询只补新复制的条目：拿回列表后按条目 id 保留键盘选中，不把光标弹回首行。
  useEffect(() => {
    if (typeof launcher?.request !== 'function') return undefined;
    let stopped = false;
    const tick = async () => {
      if (stopped || busyRef.current || confirmRef.current || renamingRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const requestedQuery = queryRef.current;
      const requestedFilter = filterRef.current;
      try {
        const value = checkResult(await launcher.request('list', { query: requestedQuery, filter: requestedFilter }));
        if (stopped || requestedQuery !== queryRef.current || requestedFilter !== filterRef.current) return;
        applyList(value);
        setError('');
      } catch {
        // 轮询失败不打断正在输入的人：下一次再试，错误由动作或首屏请求报告。
      }
    };
    const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [applyList, launcher]);

  // 每次窗口重新出现（focus / 可见）都回到「刚唤出」的样子：清空搜索、重取列表、选中首条。
  useEffect(() => {
    let frame = 0;
    const restore = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'hidden') return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        queryRef.current = '';
        setQuery('');
        setActive(0);
        activeIdRef.current = '';
        setRenaming(null);
        setConfirming(false);
        setNotice('');
        refreshNow();
        void readStatus();
        focusInput(true);
      });
    };
    window.addEventListener('focus', restore);
    document.addEventListener('visibilitychange', restore);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('focus', restore);
      document.removeEventListener('visibilitychange', restore);
    };
  }, [focusInput, readStatus, refreshNow]);

  // 选中条目的全文按需载入；请求序号防过期，迟到的响应不会盖掉当前选中项。
  useEffect(() => {
    if (!activeId) {
      setDetail(null);
      setDetailLoading(false);
      return undefined;
    }
    const cached = detailCache.current.get(activeId);
    if (cached) {
      setDetail(cached);
      setDetailLoading(false);
      return undefined;
    }
    if (typeof launcher?.request !== 'function') return undefined;
    let cancelled = false;
    detailSeq.current += 1;
    const seq = detailSeq.current;
    setDetail((previous) => (previous?.id === activeId ? previous : null));
    setDetailLoading(true);
    (async () => {
      try {
        const value = checkResult(await launcher.request('detail', { id: activeId }));
        if (!value?.item && !value?.text && !value?.previewImage) return;
        const entry = { id: activeId, ...value };
        detailCache.current.set(activeId, entry);
        if (detailCache.current.size > DETAIL_CACHE_LIMIT) {
          detailCache.current.delete(detailCache.current.keys().next().value);
        }
        if (!cancelled && seq === detailSeq.current && mounted.current) setDetail(entry);
      } catch {
        // 预览失败时列表里的摘要仍然可用，不额外报错。
      } finally {
        if (!cancelled && seq === detailSeq.current && mounted.current) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId, launcher]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, items.length]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => {
      if (mounted.current) setNotice('');
    }, NOTICE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const closeLauncher = useCallback(async () => {
    try {
      if (launcher?.close) checkResult(await launcher.close());
    } catch (cause) {
      if (mounted.current) setNotice(`无法关闭：${errorText(cause)}`);
    }
  }, [launcher]);

  const openSettings = useCallback(async () => {
    if (typeof launcher?.configure !== 'function') return;
    try {
      checkResult(await launcher.configure());
    } catch (cause) {
      if (mounted.current) setNotice(`无法打开设置：${errorText(cause)}`);
    }
  }, [launcher]);

  const closeMenu = useCallback(() => setMenu(null), []);

  /**
   * 右键菜单只承载「整理」这一类动作（固定 / 重命名 / 删除），复制与粘贴仍然是点一下条目。
   * 坐标相对列表区计算，贴近右/下边缘时向内收，不越出浮窗。
   */
  const openMenu = useCallback((item, event) => {
    const rect = bodyRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 184;
    // 六项 + 两条分隔的估算高度：只用来决定向上还是向下展开。
    const height = 232;
    setMenu({
      id: item.id,
      x: Math.max(4, Math.min(rect.width - width - 4, event.clientX - rect.left)),
      y: Math.max(4, Math.min(rect.height - height - 4, event.clientY - rect.top)),
    });
  }, []);

  // 菜单浮在列表之上：点到外面、窗口失焦或列表重排时先收起，避免挂在一个已经被删掉的条目上。
  useEffect(() => {
    if (!menu) return undefined;
    const dismiss = (event) => {
      if (event.target instanceof Element && event.target.closest('.maccy-menu')) return;
      setMenu(null);
    };
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('blur', closeMenu);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('blur', closeMenu);
    };
  }, [closeMenu, menu]);

  // 条目在菜单开着的时候被轮询刷新掉（比如从别的窗口删了），菜单不能挂在一个不存在的东西上。
  useEffect(() => {
    if (menu && !menuItem) setMenu(null);
  }, [menu, menuItem]);

  const begin = useCallback(() => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setNotice('');
    return true;
  }, []);

  const end = useCallback(() => {
    busyRef.current = false;
    if (mounted.current) setBusy(false);
  }, []);

  /**
   * 后端负责写入系统剪贴板、关闭原生窗口并（在需要时）回贴；前端只是在成功之后收尾。
   * 失败时不关窗——浮窗是用户唯一能看到原因的地方。
   */
  const selectItem = useCallback(
    async (item, mode = 'default') => {
      if (!item || typeof launcher?.request !== 'function' || !begin()) return;
      try {
        const value = checkResult(await launcher.request('select', { id: item.id, mode }));
        if (value?.warning) {
          if (mounted.current) setNotice(value.warning);
          refreshNow();
          return;
        }
        await closeLauncher();
      } catch (cause) {
        if (mounted.current) setNotice(errorText(cause));
      } finally {
        end();
      }
    },
    [begin, closeLauncher, end, launcher, refreshNow],
  );

  const mutate = useCallback(
    async (action, input, label) => {
      if (typeof launcher?.request !== 'function' || !begin()) return false;
      try {
        checkResult(await launcher.request(action, input));
        refreshNow();
        return true;
      } catch (cause) {
        if (mounted.current) setNotice(`${label}失败：${errorText(cause)}`);
        return false;
      } finally {
        end();
      }
    },
    [begin, end, launcher, refreshNow],
  );

  const togglePin = useCallback(
    async (item) => {
      if (!item) return;
      // 固定只影响列表徽标与顺序，详情内容不变，缓存留着复用。
      await mutate('pin', { id: item.id }, item.pinned ? '取消固定' : '固定');
      focusInput();
    },
    [focusInput, mutate],
  );

  const removeItem = useCallback(
    async (item) => {
      if (!item) return;
      const ok = await mutate('delete', { id: item.id }, '删除');
      if (ok) detailCache.current.delete(item.id);
      focusInput();
    },
    [focusInput, mutate],
  );

  const setPaused = useCallback(
    async (next) => {
      await mutate('pause', { paused: next }, next ? '暂停记录' : '继续记录');
      focusInput();
    },
    [focusInput, mutate],
  );

  const runClear = useCallback(
    async (includePinned) => {
      setConfirming(false);
      await mutate('clear', { includePinned }, '清理');
      detailCache.current.clear();
      focusInput();
    },
    [focusInput, mutate],
  );

  const startRename = useCallback((item) => {
    if (!item) return;
    // 没有自定义标题时先把现在显示的那句放进去，改一个字就有一个标题。
    setRenaming({ id: item.id, title: String(item.title || item.textPreview || '').slice(0, 120) });
  }, []);

  const cancelRename = useCallback(() => {
    setRenaming(null);
    requestAnimationFrame(() => focusInput(true));
  }, [focusInput]);

  const commitRename = useCallback(async () => {
    const target = renamingRef.current;
    if (!target) return;
    const title = String(target.title || '').trim();
    if (!title) {
      setNotice('标题不能为空，改成一句话或按 Esc 取消。');
      return;
    }
    const ok = await mutate('rename', { id: target.id, title }, '重命名');
    if (ok) cancelRename();
  }, [cancelRename, mutate]);

  const retryNative = useCallback(async () => {
    if (typeof launcher?.request !== 'function' || !begin()) return;
    try {
      checkResult(await launcher.request('nativeStatus', {}));
      if (mounted.current) setNotice('已重新检测系统剪贴板权限。');
      refreshNow();
    } catch (cause) {
      if (mounted.current) setNotice(`重新检测失败：${errorText(cause)}`);
    } finally {
      end();
    }
  }, [begin, end, launcher, refreshNow]);

  const retryShortcut = useCallback(async () => {
    if (typeof launcher?.retry !== 'function') return;
    try {
      checkResult(await launcher.retry());
    } catch (cause) {
      if (mounted.current) setNotice(`重试失败：${errorText(cause)}`);
    }
    await readStatus();
  }, [launcher, readStatus]);

  const move = useCallback(
    (to) => {
      const last = itemsRef.current.length - 1;
      if (last < 0) return;
      if (to === 'first') {
        chooseIndex(0);
        return;
      }
      if (to === 'last') {
        chooseIndex(last);
        return;
      }
      const step = to === 'pageNext' ? 10 : to === 'pagePrev' ? -10 : to === 'next' ? 1 : -1;
      chooseIndex(Math.max(0, Math.min(last, activeRef.current + step)));
    },
    [chooseIndex],
  );

  const handleKeyDown = (event) => {
    if (event.nativeEvent?.isComposing || composing.current || event.keyCode === 229) return;
    if (renamingRef.current) {
      // 重命名输入框自己处理 ↵ / Esc；这里只兜住漏出来的 Esc。
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelRename();
      }
      return;
    }
    if (menu) {
      // 右键菜单打开时键盘仍归搜索框：先收起菜单；Esc 只收菜单，不关窗口。
      setMenu(null);
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    const decision = resolveShortcut(
      {
        key: event.key,
        code: event.code,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
      },
      { pinnedKeys },
    );
    if (!decision) return;

    if (confirming) {
      if (decision.type === 'escape') {
        event.preventDefault();
        event.stopPropagation();
        setConfirming(false);
        focusInput(true);
      }
      return;
    }

    if (decision.type === 'escape') {
      event.preventDefault();
      event.stopPropagation();
      void closeLauncher();
      return;
    }
    if (decision.type === 'configure') {
      event.preventDefault();
      event.stopPropagation();
      void openSettings();
      return;
    }
    if (decision.type === 'move') {
      if (!items.length) return;
      event.preventDefault();
      event.stopPropagation();
      move(decision.to);
      return;
    }
    if (decision.type === 'clear') {
      event.preventDefault();
      event.stopPropagation();
      setConfirming(true);
      return;
    }
    if (decision.type === 'pin') {
      if (!activeItem) return;
      event.preventDefault();
      event.stopPropagation();
      void togglePin(activeItem);
      return;
    }
    if (decision.type === 'delete') {
      if (!activeItem) return;
      event.preventDefault();
      event.stopPropagation();
      void removeItem(activeItem);
      return;
    }
    if (decision.type === 'select') {
      const target = decision.id ? items.find((item) => item.id === decision.id) : items[decision.index ?? active];
      if (!target) return;
      // 输入框里的回车仍然归输入法 / 表单；列表外（比如按钮上）让原生行为走完。
      if (event.key === 'Enter' && event.target instanceof HTMLElement && event.target.tagName === 'BUTTON') return;
      event.preventDefault();
      event.stopPropagation();
      const index = items.indexOf(target);
      if (index >= 0) chooseIndex(index);
      void selectItem(target, decision.mode);
    }
  };

  const system = systemNotice({ native: data?.native, status });
  const showEmpty = !loading && !items.length && !failure;

  return (
    <section className="mica-config-ui maccy" aria-label="剪贴板历史" onKeyDown={handleKeyDown}>
      <header className="maccy-head">
        <Search size={15} className="maccy-head-icon" aria-hidden="true" />
        <Input
          ref={inputRef}
          className="maccy-input"
          autoFocus
          value={query}
          disabled={busy}
          // 暂停只影响新记录，已有历史照样能搜：状态交给筛选行的胶囊，不占搜索框的提示位。
          placeholder="搜索剪贴板…"
          aria-label="搜索剪贴板"
          role="combobox"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded={items.length > 0}
          aria-activedescendant={activeItem && !showEmpty ? `${listId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onChange={(value) => {
            queryRef.current = value;
            setQuery(value);
            setActive(0);
            activeIdRef.current = '';
            setError('');
          }}
        />
        {busy || (loading && !items.length) ? <Loader2 size={14} className="maccy-spin" aria-hidden="true" /> : null}
      </header>

      <div className="maccy-filters">
        <Segmented
          size="compact"
          value={filter}
          ariaLabel="按类型筛选"
          options={FILTERS}
          disabled={busy}
          onChange={(value) => {
            filterRef.current = value;
            setFilter(value);
            setActive(0);
            activeIdRef.current = '';
          }}
        />
        <div className="maccy-filters-meta">
          {paused ? (
            // 暂停没有独立的按钮：这个胶囊本身就是开关，点一下继续记录。
            <button
              type="button"
              className="maccy-chip is-warn is-action"
              title="点击继续记录"
              disabled={busy}
              onClick={() => void setPaused(false)}
            >
              已暂停 · 继续记录
            </button>
          ) : null}
          {ignoreNext ? <span className="maccy-chip">下一次不记录</span> : null}
          <span className="maccy-count" role="status">
            {countText({ loading: loading && !items.length, total, pinnedCount, query: query.trim() })}
          </span>
        </div>
      </div>

      {notice ? (
        <div className="maccy-notice is-error" role="alert">
          <AlertCircle size={13} aria-hidden="true" />
          <span>{notice}</span>
          <ArcoAction
            iconOnly
            className="maccy-action"
            title="关闭提示"
            aria-label="关闭提示"
            onClick={() => setNotice('')}
          >
            <X size={12} aria-hidden="true" />
          </ArcoAction>
        </div>
      ) : null}

      {failure ? (
        <div className="maccy-notice is-error" role="alert">
          <AlertCircle size={13} aria-hidden="true" />
          <span>{failure}</span>
          {error ? (
            <ArcoAction className="maccy-text-action" onClick={refreshNow}>
              重试
            </ArcoAction>
          ) : null}
        </div>
      ) : null}

      {system ? (
        <div className="maccy-notice" data-tone={system.tone}>
          <AlertCircle size={13} aria-hidden="true" />
          <span>{system.text}</span>
          {system.action === 'native' ? (
            <ArcoAction className="maccy-text-action" disabled={busy} onClick={() => void retryNative()}>
              重新检测
            </ArcoAction>
          ) : null}
          {system.action === 'retry' ? (
            <ArcoAction className="maccy-text-action" onClick={() => void retryShortcut()}>
              重试
            </ArcoAction>
          ) : null}
          <ArcoAction className="maccy-text-action" onClick={() => void openSettings()}>
            设置
          </ArcoAction>
        </div>
      ) : null}

      {renaming ? (
        <div className="maccy-rename">
          <Pencil size={13} aria-hidden="true" />
          <Input
            className="maccy-rename-input"
            autoFocus
            value={renaming.title}
            aria-label="编辑标题"
            placeholder="给这个条目起个名字"
            onChange={(value) => setRenaming((previous) => (previous ? { ...previous, title: value } : previous))}
            onKeyDown={(event) => {
              if (event.nativeEvent?.isComposing || composing.current || event.keyCode === 229) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                void commitRename();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                cancelRename();
              }
            }}
          />
          <Button size="compact" variant="accent" disabled={busy} onClick={() => void commitRename()}>
            保存
          </Button>
          <Button size="compact" variant="ghost" disabled={busy} onClick={cancelRename}>
            取消
          </Button>
        </div>
      ) : null}

      <div ref={bodyRef} className={`maccy-body${showPreview && activeItem ? ' has-preview' : ''}`}>
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={query.trim() ? '剪贴板搜索结果' : '剪贴板历史'}
          aria-busy={loading}
          className="maccy-list"
          onScroll={closeMenu}
        >
          {items.map((item, index) => {
            const isActive = index === active;
            const label = itemLabel(item);
            return (
              <li
                key={item.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={isActive}
                aria-label={`${kindLabel(item.kind)}：${label}`}
                data-index={index}
                data-image-id={item.kind === 'image' ? item.id : undefined}
                className={`maccy-row${item.kind === 'image' ? ' is-image' : ''}`}
                title={item.textPreview || label}
                onMouseMove={() => {
                  // 菜单开着时不动选中：否则在菜单底下划过一行，右侧预览会跟着跳。
                  if (!menu) chooseIndex(index);
                }}
                onMouseDown={(event) => event.preventDefault()}
                onContextMenu={(event) => {
                  event.preventDefault();
                  chooseIndex(index);
                  openMenu(item, event);
                }}
                onClick={(event) => {
                  chooseIndex(index);
                  void selectItem(item, event.altKey ? (event.shiftKey ? 'plain' : 'paste') : 'default');
                }}
              >
                <span className="maccy-row-icon" aria-hidden="true">
                  {item.kind === 'image' ? (
                    <ClipboardThumbnail source={thumbnails.get(item.id) || ''} />
                  ) : (
                    <KindIcon kind={item.kind} />
                  )}
                </span>
                <span className="maccy-row-title">{label}</span>
                {item.pinned ? (
                  <span className="maccy-row-pin" title="已固定">
                    <Pin size={11} aria-hidden="true" />
                  </span>
                ) : null}
                <span className="maccy-row-meta">{itemMeta(item, now)}</span>
              </li>
            );
          })}
        </ul>

        {showPreview && activeItem ? (
          <PreviewPane item={activeItem} detail={activeDetail} loading={detailLoading} now={now} />
        ) : null}

        {showEmpty ? (
          <ClipboardEmpty
            query={query}
            filter={filter}
            paused={paused}
            onClearQuery={() => {
              queryRef.current = '';
              setQuery('');
              setActive(0);
              activeIdRef.current = '';
              focusInput(true);
            }}
            onShowAll={() => {
              filterRef.current = 'all';
              setFilter('all');
              setActive(0);
              activeIdRef.current = '';
            }}
            onResume={() => void setPaused(false)}
            onConfigure={() => void openSettings()}
          />
        ) : null}

        {loading && !items.length ? (
          <p className="maccy-loading" role="status">
            正在载入剪贴板历史…
          </p>
        ) : null}

        {menu && menuItem ? (
          <MenuList
            className="maccy-menu"
            style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
            onClose={closeMenu}
            onContextMenu={(event) => event.preventDefault()}
          >
            <MenuItem
              icon={<Copy size={13} />}
              onClick={() => {
                closeMenu();
                void selectItem(menuItem, 'copy');
              }}
            >
              复制
            </MenuItem>
            <MenuItem
              icon={<ClipboardPaste size={13} />}
              onClick={() => {
                closeMenu();
                void selectItem(menuItem, 'paste');
              }}
            >
              粘贴
            </MenuItem>
            <MenuItem
              icon={<Type size={13} />}
              disabled={busy || menuItem.kind !== 'text'}
              title={menuItem.kind === 'text' ? '只粘贴纯文本' : '只有文本条目能纯文本粘贴'}
              onClick={() => {
                closeMenu();
                void selectItem(menuItem, 'plain');
              }}
            >
              纯文本粘贴
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={<Pin size={13} />}
              disabled={busy}
              onClick={() => {
                closeMenu();
                void togglePin(menuItem);
              }}
            >
              {menuItem.pinned ? '取消固定' : '固定'}
            </MenuItem>
            <MenuItem
              icon={<Pencil size={13} />}
              disabled={busy}
              onClick={() => {
                closeMenu();
                startRename(menuItem);
              }}
            >
              重命名
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              danger
              icon={<Trash2 size={13} />}
              disabled={busy}
              onClick={() => {
                closeMenu();
                void removeItem(menuItem);
              }}
            >
              删除
            </MenuItem>
          </MenuList>
        ) : null}
      </div>

      {showFooter ? (
        <footer className="maccy-foot">
          <span className="maccy-hints">点击{settings.pasteAutomatically ? '粘贴' : '复制'} · 右键更多 · Esc 关闭</span>
          <span className="maccy-foot-meta">
            {status?.registered && status.shortcut ? (
              <>
                <span className="maccy-foot-mode">唤出</span>
                <span className="maccy-foot-shortcut" title={`系统唤出快捷键：${status.shortcut}`}>
                  {formatShortcut(status.shortcut)}
                </span>
              </>
            ) : null}
          </span>
        </footer>
      ) : null}

      {confirming ? (
        <Modal
          title="清理剪贴板历史"
          onClose={() => {
            if (!busyRef.current) setConfirming(false);
          }}
        >
          <p className="maccy-clear-description">
            清空未固定条目会保留所有固定条目；清空全部会连同固定条目一起删除，无法撤销。
          </p>
          <div className="maccy-dialog-actions">
            <Button
              size="compact"
              autoFocus
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                focusInput(true);
              }}
            >
              取消
            </Button>
            <span className="maccy-dialog-gap" />
            <Button size="compact" variant="danger-ghost" disabled={busy} onClick={() => void runClear(false)}>
              清空未固定
            </Button>
            <Button size="compact" variant="danger" disabled={busy} onClick={() => void runClear(true)}>
              清空全部
            </Button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}

export default Launcher;

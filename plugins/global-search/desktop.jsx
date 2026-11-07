import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  AlertCircle,
  File,
  Folder,
  Loader2,
  Search,
  Settings2,
  X,
} from 'lucide-react';
import './desktop.css';

export const card = { width: 640 };

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function checkResult(result) {
  if (result === false || result?.ok === false) {
    throw new Error(result?.error || '操作未完成，请重试。');
  }
  return result;
}

const HOME_PREFIX = /^(?:\/Users|\/home)\/[^/]+/;

/**
 * 行右侧的位置列：家目录下的路径显示成 `~/Desktop/…`，超出四段就只留末四段并以
 * `…/` 开头。截断后不再缀 `~/`——`~/…/a/b` 读起来像是路径里真有个省略号目录。
 */
function displayPath(value, { parent = false, keep = 4 } = {}) {
  let target = String(value || '').replace(/\\/g, '/');
  if (parent) target = target.replace(/\/[^/]+\/?$/, '') || '/';
  const home = target.replace(HOME_PREFIX, '~');
  const parts = home.split('/').filter(Boolean);
  if (parts.length <= keep) return home;
  return `…/${parts.slice(-keep).join('/')}`;
}

export function Launcher({ api, onClose }) {
  const launcher = api?.launcher;
  const listId = useId();
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const sequence = useRef(0);
  const mounted = useRef(false);
  const openingRef = useRef(false);
  const composing = useRef(false);
  const immediate = useRef(true);
  const [query, setQuery] = useState('');
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState(null);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState(null);

  const focusInput = useCallback(() => {
    if (openingRef.current) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const readStatus = useCallback(async () => {
    try {
      const value = checkResult(await launcher.status());
      if (mounted.current) setStatus({ native: true, ...value });
    } catch (cause) {
      if (mounted.current) setStatus({ native: true, registered: false, error: errorText(cause) });
    }
  }, [launcher]);

  const refresh = useCallback(() => {
    sequence.current += 1;
    immediate.current = true;
    setResult(null);
    setLoading(true);
    setRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void readStatus();
    return () => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, [readStatus]);

  useEffect(() => {
    const requestId = ++sequence.current;
    const forceRefresh = immediate.current;
    immediate.current = false;
    setResult(null);
    setLoading(true);
    setError('');
    setActive(0);
    const timer = setTimeout(
      async () => {
        try {
          const value = checkResult(await launcher.request('search', { query, refresh: forceRefresh }));
          if (!mounted.current || requestId !== sequence.current) return;
          setResult({
            ...value,
            items: Array.isArray(value?.items) ? value.items : [],
            roots: Array.isArray(value?.roots) ? value.roots : [],
          });
        } catch (cause) {
          if (mounted.current && requestId === sequence.current) setError(errorText(cause));
        } finally {
          if (mounted.current && requestId === sequence.current) setLoading(false);
        }
      },
      forceRefresh ? 0 : 200,
    );
    return () => {
      clearTimeout(timer);
      if (sequence.current === requestId) sequence.current += 1;
    };
  }, [launcher, query, revision]);

  useEffect(() => {
    let frame;
    const restore = () => {
      if (document.visibilityState === 'hidden') return;
      // Visibility and focus commonly arrive together when the launcher is shown.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        refresh();
        void readStatus();
        focusInput();
      });
    };
    window.addEventListener('focus', restore);
    document.addEventListener('visibilitychange', restore);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('focus', restore);
      document.removeEventListener('visibilitychange', restore);
    };
  }, [focusInput, readStatus, refresh]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-result-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, result]);

  const close = useCallback(async () => {
    try {
      if (launcher?.close) checkResult(await launcher.close());
      else onClose?.();
    } catch (cause) {
      if (mounted.current) setError(`无法关闭：${errorText(cause)}`);
    }
  }, [launcher, onClose]);

  const configure = async () => {
    if (openingRef.current) return;
    try {
      checkResult(await launcher.configure());
    } catch (cause) {
      if (mounted.current) setError(`无法打开设置：${errorText(cause)}`);
    }
  };

  const items = result?.items ?? [];
  const blocked = loading || opening;
  const openItem = async (item) => {
    if (loading || openingRef.current || !item || !items.includes(item)) return;
    openingRef.current = true;
    setOpening(true);
    setError('');
    let opened = false;
    try {
      checkResult(await launcher.openPath(item.path));
      opened = true;
      checkResult(await launcher.request('remember', { path: item.path }));
      await close();
    } catch (cause) {
      if (mounted.current) {
        setError(`${opened ? '已在 Mica 打开，但无法记录最近打开：' : '无法打开：'}${errorText(cause)}`);
      }
    } finally {
      openingRef.current = false;
      if (mounted.current) {
        setOpening(false);
        inputRef.current?.focus();
      }
    }
  };

  const handleKeyDown = (event) => {
    if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      void close();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(event.key)) return;
    // Preserve ordinary text-selection shortcuts in the search field.
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    // Toolbar and result buttons retain their own native Enter activation.
    if (event.key === 'Enter' && event.target !== inputRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    if (blocked || !items.length) return;
    if (event.key === 'Enter') void openItem(items[active]);
    else if (event.key === 'Home') setActive(0);
    else if (event.key === 'End') setActive(items.length - 1);
    else setActive((value) => Math.max(0, Math.min(items.length - 1, value + (event.key === 'ArrowDown' ? 1 : -1))));
  };

  const roots = result?.roots ?? [];
  const scope = roots.length ? roots.map((root) => displayPath(root)).join(' · ') : '尚未设置搜索目录';
  const statusMessage =
    status?.native === false
      ? '当前环境不提供系统快捷键，仍可使用搜索列表并在 Mica 中打开。'
      : status && !status.registered
        ? `系统快捷键未注册${status.shortcut ? `（${status.shortcut}）` : ''}${status.error ? `：${status.error}` : '，可在设置中调整。'}`
        : status?.error;

  return (
    <section className="mica-config-ui global-search" aria-label="全局文件搜索" onKeyDown={handleKeyDown}>
      <header className="global-search-head">
        <Search size={15} aria-hidden="true" />
        <input
          ref={inputRef}
          className="global-search-input"
          autoFocus
          value={query}
          disabled={opening}
          placeholder="搜索文件或文件夹…"
          aria-label="搜索文件或文件夹"
          role="combobox"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded={items.length > 0}
          aria-activedescendant={!blocked && items[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onChange={(event) => {
            sequence.current += 1;
            setQuery(event.target.value);
            setResult(null);
            setLoading(true);
            setError('');
            setActive(0);
          }}
        />
        {loading || opening ? (
          <Loader2 size={14} className="global-search-spin" aria-hidden="true" />
        ) : null}
        <button
          type="button"
          className="global-search-icon"
          title="设置搜索目录"
          aria-label="设置搜索目录"
          disabled={opening}
          onClick={() => void configure()}
        >
          <Settings2 size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="global-search-icon"
          title="关闭（Esc）"
          aria-label="关闭"
          disabled={opening}
          onClick={() => void close()}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </header>

      {statusMessage ? (
        <div className="global-search-notice" title={status?.error}>
          <AlertCircle size={13} aria-hidden="true" />
          <span>{statusMessage}</span>
          {status?.native && !status.registered ? (
            <button
              type="button"
              className="global-search-link"
              disabled={opening}
              onClick={() => {
                void launcher
                  .retry()
                  .then(readStatus)
                  .catch((cause) => setError(errorText(cause)));
              }}
            >
              重试
            </button>
          ) : null}
          <button
            type="button"
            className="global-search-link"
            disabled={opening}
            onClick={() => void configure()}
          >
            设置
          </button>
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="global-search-notice is-error">
          <span>{error}</span>
        </div>
      ) : null}

      <div className="global-search-body">
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={query.trim() ? '搜索结果' : '最近打开'}
          aria-busy={loading}
          className="global-search-list"
        >
          {items.map((item, index) => (
            <li
              key={item.path}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={active === index}
              aria-disabled={blocked || undefined}
              data-result-index={index}
              title={item.path}
              className="global-search-row"
              onMouseMove={() => setActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setActive(index);
                void openItem(item);
              }}
            >
              <span className="global-search-row-icon" aria-hidden="true">
                {item.type === 'directory' ? <Folder size={14} /> : <File size={14} />}
              </span>
              <span className="global-search-row-name">{item.name}</span>
              <span className="global-search-row-path">{displayPath(item.path, { parent: true })}</span>
            </li>
          ))}
        </ul>

        {loading && !items.length ? (
          <p role="status" className="global-search-empty">
            正在搜索…
          </p>
        ) : null}
        {!loading && !items.length && !error ? (
          <div className="global-search-empty">
            <Folder size={20} className="global-search-empty-icon" aria-hidden="true" />
            <span className="global-search-empty-title">
              {!roots.length
                ? '先添加要搜索的目录'
                : query.trim()
                  ? '没有找到匹配的文件或文件夹'
                  : '还没有最近打开的文件'}
            </span>
            <span>
              {!roots.length
                ? '添加目录后即可跨项目搜索文件与文件夹。'
                : query.trim()
                  ? '试试更短的关键词。'
                  : '输入关键词开始搜索。'}
            </span>
            <button
              type="button"
              className="global-search-link"
              disabled={opening}
              onClick={() => void configure()}
            >
              设置搜索目录
            </button>
          </div>
        ) : null}
      </div>

      <footer className="global-search-foot">
        <span className="global-search-hints">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> 选择
          </span>
          <span>
            <kbd>↵</kbd> 打开
          </span>
          <span>
            <kbd>Esc</kbd> 关闭
          </span>
        </span>
        <span className="global-search-foot-meta">
          <span className="global-search-count" role="status">
            {opening
              ? '正在打开…'
              : loading
                ? '搜索中…'
                : `${items.length} 个${query.trim() ? '结果' : '条目'}`}
          </span>
          <span className="global-search-scope" title={roots.join('\n') || scope}>
            {result ? scope : ''}
          </span>
          {status?.registered && status.shortcut ? <kbd>{status.shortcut}</kbd> : null}
        </span>
      </footer>
    </section>
  );
}

export default Launcher;

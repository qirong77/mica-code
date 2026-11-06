import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CornerDownLeft,
  File,
  Folder,
  Loader2,
  Search,
  Settings2,
  X,
} from 'lucide-react';
import { Button } from '@mica-config-ui/web';
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

function shortPath(path) {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 4 ? `…/${parts.slice(-4).join('/')}` : path;
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
            warnings: Array.isArray(value?.warnings) ? value.warnings : [],
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
  const scope = roots.length ? roots.map(shortPath).join(' · ') : '尚未设置搜索目录';
  const statusMessage =
    status?.native === false
      ? '当前环境不提供系统快捷键，仍可使用搜索列表并在 Mica 中打开。'
      : status && !status.registered
        ? `系统快捷键未注册${status.shortcut ? `（${status.shortcut}）` : ''}${status.error ? `：${status.error}` : '，可在设置中调整。'}`
        : status?.error;

  return (
    <section className="mica-config-ui global-search" aria-label="全局文件搜索" onKeyDown={handleKeyDown}>
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--line-soft)] px-4 py-3">
        <Search size={20} className="shrink-0 text-[var(--text-soft)]" aria-hidden="true" />
        <input
          ref={inputRef}
          className="text-input global-search-input min-w-0 flex-1"
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
          <Loader2 size={16} className="shrink-0 animate-spin text-[var(--text-soft)]" aria-hidden="true" />
        ) : null}
        <Button
          variant="ghost"
          icon={<Settings2 />}
          title="设置搜索目录"
          disabled={opening}
          onClick={() => void configure()}
        />
        <Button variant="ghost" icon={<X />} title="关闭（Esc）" disabled={opening} onClick={() => void close()} />
      </header>

      {statusMessage ? (
        <div
          className="flex shrink-0 items-center gap-2 border-b border-[var(--line-soft)] px-4 py-2 text-xs text-[var(--text-soft)]"
          title={status?.error}
        >
          <AlertCircle size={14} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">{statusMessage}</span>
          {status?.native && !status.registered ? (
            <Button
              variant="ghost"
              size="compact"
              disabled={opening}
              onClick={() => {
                void launcher
                  .retry()
                  .then(readStatus)
                  .catch((cause) => setError(errorText(cause)));
              }}
            >
              重试快捷键
            </Button>
          ) : null}
          <Button variant="ghost" size="compact" disabled={opening} onClick={() => void configure()}>
            设置
          </Button>
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="shrink-0 break-words border-b border-[var(--line-soft)] px-4 py-2 text-xs text-[var(--red)]"
        >
          {error}
        </div>
      ) : null}

      <div ref={listRef} className="global-search-results min-h-0 flex-1 overflow-y-auto p-2" aria-busy={loading}>
        <p className="px-2 pb-1 pt-1 text-xs text-[var(--text-soft)]">
          {query.trim() ? '搜索结果' : '最近打开与搜索目录'}
        </p>
        <ul
          id={listId}
          role="listbox"
          aria-label={query.trim() ? '搜索结果' : '最近打开'}
          className="m-0 list-none p-0"
        >
          {items.map((item, index) => (
            <li
              key={item.path}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={active === index}
              data-result-index={index}
            >
              <Button
                fullWidth
                variant="ghost"
                pressed={active === index}
                disabled={blocked}
                title={item.path}
                icon={item.type === 'directory' ? <Folder /> : <File />}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setActive(index);
                  void openItem(item);
                }}
              >
                <span className="block truncate text-sm font-medium" title={item.name}>
                  {item.name}
                </span>
                <span className="block truncate text-xs text-[var(--text-soft)]" title={item.path}>
                  {shortPath(item.path)}
                </span>
              </Button>
            </li>
          ))}
        </ul>
        {loading ? (
          <p role="status" className="px-3 py-10 text-center text-sm text-[var(--text-soft)]">
            正在搜索…
          </p>
        ) : null}
        {!loading && !items.length && !error ? (
          <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
            <Folder size={28} className="text-[var(--text-faint)]" aria-hidden="true" />
            <p className="m-0 text-sm">
              {!roots.length
                ? '先添加要搜索的目录'
                : query.trim()
                  ? '没有找到匹配的文件或文件夹'
                  : '还没有最近打开的文件'}
            </p>
            <p className="m-0 text-xs text-[var(--text-soft)]">
              {!roots.length
                ? '选择目录后，即可跨项目搜索文件和文件夹。'
                : query.trim()
                  ? '试试更短的关键词，或在设置中检查搜索范围。'
                  : '输入关键词开始搜索，打开成功的项目会出现在这里。'}
            </p>
            <Button
              variant="ghost"
              size="compact"
              icon={<Settings2 />}
              disabled={opening}
              onClick={() => void configure()}
            >
              设置搜索目录
            </Button>
          </div>
        ) : null}
      </div>

      {result?.warnings.length || result?.truncated ? (
        <div
          className="global-search-warnings shrink-0 overflow-y-auto border-t border-[var(--line-soft)] px-4 py-2 text-xs text-[var(--amber)]"
          role="status"
        >
          {result.warnings.length ? <p className="m-0 mb-1 font-medium">部分目录扫描未完成，结果可能不完整。</p> : null}
          {result.warnings.map((warning, index) => (
            <p className="m-0 break-words" key={index}>
              {typeof warning === 'string' ? warning : warning.message || warning.error || JSON.stringify(warning)}
            </p>
          ))}
          {result.truncated ? <p className="m-0">结果已截断，请缩小关键词或调整搜索目录。</p> : null}
          <Button variant="ghost" size="compact" disabled={opening} onClick={() => void configure()}>
            检查搜索设置
          </Button>
        </div>
      ) : null}

      <footer className="flex shrink-0 flex-col gap-1 border-t border-[var(--line-soft)] px-4 py-2 text-xs text-[var(--text-soft)]">
        <div className="flex min-w-0 items-center gap-2">
          <span role="status" className="shrink-0">
            {opening ? '正在 Mica 中打开…' : loading ? '搜索中' : `${items.length} 个${query.trim() ? '结果' : '条目'}`}
          </span>
          {Number.isFinite(result?.indexed) ? <span className="shrink-0">· 已索引 {result.indexed} 项</span> : null}
          <span className="min-w-0 flex-1 truncate text-right" title={roots.join('\n') || scope}>
            范围：{loading ? '读取中…' : result ? scope : '读取失败'}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1">
            <ArrowUp size={11} />
            <ArrowDown size={11} />
            选择
          </span>
          <span>Home / End 首尾</span>
          <span className="inline-flex items-center gap-1">
            <CornerDownLeft size={12} />在 Mica 打开
          </span>
          <span>Esc 关闭</span>
          {status?.registered && status.shortcut ? (
            <span className="ml-auto" title="系统快捷键">
              {status.shortcut}
            </span>
          ) : null}
        </div>
      </footer>
    </section>
  );
}

export default Launcher;

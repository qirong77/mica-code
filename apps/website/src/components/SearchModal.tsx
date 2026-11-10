import { useEffect, useMemo, useState } from 'react';
import Button from '@arco-design/web-react/es/Button';
import Modal from '@arco-design/web-react/es/Modal';
import Input from '@arco-design/web-react/es/Input';
import '@arco-design/web-react/es/Modal/style/index.css';
import '@arco-design/web-react/es/Input/style/index.css';
import type { SearchPage } from './DocsSearch';

interface SearchEntry extends SearchPage {
  text: string;
  url: string;
}

interface Props {
  pages: SearchPage[];
  base: string;
  visible: boolean;
  onClose: () => void;
  onAfterClose: () => void;
}

// Only public documentation text is cached; failed requests are retried when search opens again.
const articleCache = new Map<string, string>();

export default function SearchModal({ pages, base, visible, onClose, onAfterClose }: Props) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [indexing, setIndexing] = useState(false);
  const [failed, setFailed] = useState(0);
  const [entries, setEntries] = useState<SearchEntry[]>(() =>
    [{ key: '', title: '文档概览', description: '从安装、日常开发到扩展与集成，找到合适的指南。' }, ...pages].map(
      (page) => ({ ...page, text: '', url: `${base}docs/${page.key ? `${page.key}/` : ''}` }),
    ),
  );

  useEffect(() => {
    if (!visible) return;
    let active = true;
    const controller = new AbortController();
    const currentPath = location.pathname.replace(/\/$/, '');
    const currentText = document.querySelector('.doc-main')?.textContent?.replace(/\s+/g, ' ').trim();
    const initial = entries.map((entry) => {
      const cached = articleCache.get(entry.url);
      const text = cached || (entry.url.replace(/\/$/, '') === currentPath ? currentText : '') || entry.text;
      if (text) articleCache.set(entry.url, text);
      return { ...entry, text };
    });
    setEntries(initial);
    const missing = initial.filter((entry) => !entry.text);
    setIndexing(missing.length > 0);
    setFailed(0);
    let failures = 0;
    void Promise.all(
      missing.map(async (entry) => {
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
          const response = await fetch(entry.url, { signal: controller.signal });
          if (!response.ok) throw new Error('Page unavailable');
          const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
          const text = doc.querySelector('.doc-main')?.textContent?.replace(/\s+/g, ' ').trim();
          if (!text) throw new Error('Page content unavailable');
          articleCache.set(entry.url, text);
          if (active)
            setEntries((current) => current.map((item) => (item.url === entry.url ? { ...item, text } : item)));
        } catch {
          failures++;
        } finally {
          clearTimeout(timeout);
        }
      }),
    ).then(() => {
      if (active) {
        setFailed(failures);
        setIndexing(false);
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
    // Entries are intentionally read only when opening, so incremental updates do not restart requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = useMemo(
    () =>
      entries.filter((entry) =>
        terms.every((term) => `${entry.title} ${entry.description} ${entry.text}`.toLocaleLowerCase().includes(term)),
      ),
    [entries, query],
  );
  const current = Math.min(selected, Math.max(0, matches.length - 1));
  const status = indexing
    ? '正在加载正文索引，标题搜索已可用…'
    : failed
      ? '部分正文未能加载 · 再次打开搜索可重试'
      : `${matches.length} 篇相关文档 · ↑ ↓ 选择 · Enter 打开`;

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && matches.length) {
      event.preventDefault();
      const next = (current + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
      setSelected(next);
      document.getElementById('docs-query')?.focus();
      document.getElementById(`search-result-${next}`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && (event.target as HTMLElement).id === 'docs-query' && matches.length) {
      event.preventDefault();
      window.location.assign(matches[current].url);
    }
  };

  return (
    <Modal
      className="search-dialog"
      wrapClassName="search-dialog-wrap"
      title={
        <div className="search-title">
          <span>搜索文档</span>
          <Button className="search-close" type="text" aria-label="关闭搜索" onClick={onClose}>
            关闭 <kbd>Esc</kbd>
          </Button>
        </div>
      }
      visible={visible}
      onCancel={onClose}
      afterOpen={() => document.getElementById('docs-query')?.focus()}
      afterClose={onAfterClose}
      footer={null}
      closable={false}
      unmountOnExit
    >
      <div onKeyDown={handleKeyDown}>
        <label className="sr-only" htmlFor="docs-query">
          搜索文档标题与正文
        </label>
        <Input
          id="docs-query"
          type="search"
          placeholder="搜索模型、插件、远程访问…"
          autoComplete="off"
          value={query}
          onChange={(value) => {
            setQuery(value);
            setSelected(0);
          }}
          role="combobox"
          aria-expanded="true"
          aria-controls="search-results"
          aria-activedescendant={matches.length ? `search-result-${current}` : undefined}
        />
        <div id="search-results" className="search-results" role="listbox" aria-label="搜索结果" aria-busy={indexing}>
          {matches.map((entry, index) => {
            const matchAt = terms.length ? entry.text.toLocaleLowerCase().indexOf(terms[0]) : -1;
            const excerpt =
              matchAt >= 0 ? `…${entry.text.slice(Math.max(0, matchAt - 24), matchAt + 96)}…` : entry.description;
            return (
              <a
                id={`search-result-${index}`}
                key={entry.url}
                href={entry.url}
                role="option"
                aria-selected={index === current}
                className={index === current ? 'search-selected' : undefined}
                onMouseEnter={() => setSelected(index)}
                onFocus={() => setSelected(index)}
              >
                <strong>{entry.title}</strong>
                <span>{excerpt}</span>
              </a>
            );
          })}
          {!matches.length && (
            <p className="search-empty">
              {indexing
                ? '正在搜索文档正文…'
                : failed
                  ? '未在已加载内容中找到结果，请检查网络后重试。'
                  : '没有找到相关内容，试试其他关键词。'}
            </p>
          )}
        </div>
        <div className="search-footer" role="status" aria-live="polite">
          {status}
        </div>
      </div>
    </Modal>
  );
}

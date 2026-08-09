import { useCallback, useEffect, useRef, useState } from 'react';
import { readSessionConversationPage } from '../api.js';
import { Tag } from './Ui.js';
import { appIcons } from '../icons.js';
import type { ConfigWebConversationItem, ConfigWebConversationItemType } from '../../../src/shared/types.js';

const PAGE_SIZE = 80;

export function ConversationPane({ sessionId, refreshToken }: { sessionId: string; refreshToken: number }) {
  const [items, setItems] = useState<ConfigWebConversationItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const loadLatest = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetch the newest page first so long sessions open on recent activity.
      const page = await readSessionConversationPage(sessionId, 0, PAGE_SIZE, true);
      setItems(page.items);
      setTotal(page.total);
    } catch (loadError) {
      setError(formatError(loadError));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  const loadEarlier = useCallback(async () => {
    if (inFlight.current || loading || items.length === 0 || items.length >= total) return;
    inFlight.current = true;
    setLoadingMore(true);
    try {
      const firstSequence = items[0].sequence;
      const offset = Math.max(0, firstSequence - 1 - PAGE_SIZE);
      const page = await readSessionConversationPage(sessionId, offset, PAGE_SIZE);
      setItems((prev) => {
        if (page.items.length === 0) return prev;
        const firstPrev = prev[0].sequence;
        const fresh = page.items.filter((item) => item.sequence < firstPrev);
        if (fresh.length === 0) return prev;
        return [...fresh, ...prev];
      });
      setTotal(page.total);
    } catch (loadError) {
      setError(formatError(loadError));
    } finally {
      inFlight.current = false;
      setLoadingMore(false);
    }
  }, [sessionId, loading, items, total]);

  useEffect(() => {
    void loadLatest();
  }, [loadLatest, refreshToken]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadEarlier();
      },
      { rootMargin: '300px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadEarlier, items.length, total, loading]);

  const hasMore = items.length < total;

  if (loading && items.length === 0) {
    return <div className="session-loading">正在加载对话记录…</div>;
  }
  if (error && items.length === 0) {
    return <div className="ui-alert">{error}</div>;
  }

  return (
    <div className="conversation-pane">
      <div className="conversation-pane-toolbar">
        <span>
          共 <strong>{total}</strong> 条记录 · 已显示 {items.length} 条
        </span>
        {hasMore ? (
          <button type="button" className="ui-link-button" onClick={() => void loadLatest()}>
            回到最新
          </button>
        ) : null}
      </div>

      <div className="conversation-timeline conversation-timeline-paged">
        {hasMore ? (
          <div className="conversation-page-more" ref={sentinelRef}>
            {loadingMore ? (
              <span>正在加载更早的记录…</span>
            ) : (
              <button type="button" className="ui-button" onClick={() => void loadEarlier()}>
                加载更早（已显示 {items.length} / {total}）
              </button>
            )}
          </div>
        ) : null}
        {items.map((item) => (
          <ConversationItemCard key={`${item.sequence}-${item.type}-${item.callId ?? ''}`} item={item} />
        ))}
        <div className="conversation-pane-end">— 已到最早记录 —</div>
      </div>
    </div>
  );
}

function ConversationItemCard({ item }: { item: ConfigWebConversationItem }) {
  const metadata = [item.toolName, item.callId].filter(Boolean).join(' · ');
  const preview = contentPreview(item.content);
  const [expanded, setExpanded] = useState(false);
  const ChevronIcon = appIcons.chevronRight;

  return (
    <article className={`conversation-item conversation-item-${item.type}`}>
      <div className="conversation-sequence" aria-label={`第 ${item.sequence} 项`}>
        {item.sequence}
      </div>
      <details className="conversation-card simple-card" onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary className="conversation-card-header">
          <div className="conversation-card-title">
            <Tag tone={itemTone(item.type)}>{itemLabel(item)}</Tag>
            <div className="conversation-card-summary">
              {metadata ? (
                <span className="conversation-card-meta" title={metadata}>
                  {metadata}
                </span>
              ) : null}
              <span className="conversation-card-preview" title={preview}>
                {preview}
              </span>
            </div>
          </div>
          <span className="conversation-card-trailing">
            <ChevronIcon className="conversation-chevron" size={15} aria-hidden="true" />
          </span>
        </summary>
        {expanded ? <pre className="conversation-content">{item.content || '(empty)'}</pre> : null}
      </details>
    </article>
  );
}

function itemLabel(item: ConfigWebConversationItem): string {
  if (item.type === 'assistant') return 'LLM';
  if (item.type === 'tool_call') return 'Tool call';
  if (item.type === 'tool_result') return 'Tool result';
  if (item.type === 'reasoning') return '思考';
  if (item.type === 'unknown') return item.role || 'Other';
  return item.type.charAt(0).toUpperCase() + item.type.slice(1);
}

function itemTone(type: ConfigWebConversationItemType): 'default' | 'green' | 'red' | 'blue' {
  if (type === 'user') return 'blue';
  if (type === 'assistant') return 'green';
  return 'default';
}

function contentPreview(content: string): string {
  const sample = content.slice(0, 2_000);
  const normalized = sample.replace(/\s+/g, ' ').trim();
  if (!normalized) return '(empty)';
  return normalized.length > 240 || sample.length < content.length ? `${normalized.slice(0, 240)}…` : normalized;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

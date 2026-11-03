import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { readSessionConversationPage } from '../api.js';
import { mergeConversationPage } from '../conversationMerge.js';
import { Tag } from './Ui.js';
import { appIcons } from '../icons.js';
import { formatCharCount } from '../format.js';
import type { ConfigWebConversationItem, ConfigWebConversationItemType } from '../../src/shared/types.js';

const PAGE_SIZE = 80;

export function ConversationPane({ sessionId, refreshToken }: { sessionId: string; refreshToken: number }) {
  const [items, setItems] = useState<ConfigWebConversationItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 往上加载更早的记录时，记下加载前后的高度差，用来把画面钉在原地。 */
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  const scrolledToNewestRef = useRef(false);

  /**
   * 取最新一页并**并入**已有列表。
   *
   * 以前这里整份替换 items：快照一变（会话正在跑时每几秒一次）就会把用户翻上去的
   * 那几页丢掉，列表高度从 400 条缩回 80 条——看起来就是滚动位置乱跳、内容闪一下。
   * 并入之后定位稳定：已加载的条目保留引用，没变就完全不 setState（不重渲染）。
   */
  const loadLatest = useCallback(async () => {
    setError(null);
    try {
      // 长会话先看最近活动：最新一页在手，再往上翻。
      const page = await readSessionConversationPage(sessionId, 0, PAGE_SIZE, true);
      setItems((prev) => mergeConversationPage(prev, page.items));
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
      const fresh = page.items.filter((item) => item.sequence < firstSequence);
      if (fresh.length > 0) {
        // 插在列表最前面会把当前画面整体往下推：「加载更早」一多，正在看的那些记录
        // 就会一直往下滚。记下加载前的高度与位置，插完按差额补回 scrollTop。
        const scroll = scrollRef.current;
        anchorRef.current = scroll ? { height: scroll.scrollHeight, top: scroll.scrollTop } : null;
        setItems((prev) => {
          const firstPrev = prev[0].sequence;
          const additions = fresh.filter((item) => item.sequence < firstPrev);
          return additions.length === 0 ? prev : [...additions, ...prev];
        });
      }
      setTotal(page.total);
    } catch (loadError) {
      setError(formatError(loadError));
    } finally {
      inFlight.current = false;
      setLoadingMore(false);
    }
  }, [sessionId, loading, items, total]);

  // 首次落地：打开详情先看最近的活动。不滚到底的话，顶部那条「加载更早」的哨兵
  // 一直在视口里，会一口气把整条会话翻完（几百条），画面还停在最早那几条上。
  useEffect(() => {
    if (scrolledToNewestRef.current || items.length === 0) return;
    scrolledToNewestRef.current = true;
    const scroll = scrollRef.current;
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }, [items.length]);

  // 补回因为「前面插入」而跳掉的滚动位置（在浏览器绘制前完成，看不到跳动）。
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    anchorRef.current = null;
    const scroll = scrollRef.current;
    if (!scroll) return;
    scroll.scrollTop = anchor.top + (scroll.scrollHeight - anchor.height);
  }, [items]);

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
      // 根是这块自己的滚动容器，不是视口：内容再长，离顶部的距离也按这里算。
      { root: scrollRef.current, rootMargin: '300px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadEarlier, items.length, total, loading]);

  const hasMore = items.length < total;

  if (loading && items.length === 0) {
    // 首帧就把结构画出来（工具栏 + 滚动区），只是正文还没到：等第一条记录到达时
    // 只有内容出现，没有「小块居中文字 → 一整列卡片」这次几何跳变，看起来不闪。
    return (
      <div className="conversation-pane">
        <div className="session-pane-toolbar">
          <div className="session-pane-facts">
            <span className="muted-text">正在读取对话记录…</span>
          </div>
        </div>
        <div className="conversation-scroll">
          <div className="session-loading">正在加载对话记录…</div>
        </div>
      </div>
    );
  }
  if (error && items.length === 0) {
    return <div className="ui-alert">{error}</div>;
  }

  return (
    <div className="conversation-pane">
      <div className="session-pane-toolbar">
        <div className="session-pane-facts">
          共 <strong>{total}</strong> 条记录 · 已显示 {items.length} 条
        </div>
        <div className="session-pane-actions">
          {hasMore ? (
            <button
              type="button"
              className="ui-link-button"
              onClick={() => {
                const scroll = scrollRef.current;
                if (scroll) scroll.scrollTop = scroll.scrollHeight;
              }}
            >
              回到最新
            </button>
          ) : null}
        </div>
      </div>

      {/* 工具栏固定在顶部（合计 / 回到最新），只有记录本身滚动：滚到很上面时那一行
          「加载更早」正需要，跟着内容一起滚走就等于没有。 */}
      <div className="conversation-scroll" ref={scrollRef}>
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
          {hasMore ? null : <div className="conversation-pane-end">— 已到最早记录 —</div>}
        </div>
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
            {/* 体积写在行尾：工具结果动辄几万字符，扫一眼就知道哪条把 context 吃掉了。 */}
            <span className="conversation-card-size" title={`${item.content.length.toLocaleString()} 字符`}>
              {formatCharCount(item.content.length)} 字符
            </span>
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

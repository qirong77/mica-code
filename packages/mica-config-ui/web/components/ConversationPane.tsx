import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { readSessionConversationPage } from '../api.js';
import { mergeConversationPage } from '../conversationMerge.js';
import {
  CONVERSATION_FILTERS,
  buildTurnBlocks,
  conversationFilterOf,
  conversationItemLabel,
  conversationItemSize,
  conversationKindClass,
  conversationPreview,
  conversationRunLabel,
  describeConversationRun,
  formatTurnStats,
  matchesConversationQuery,
  splitConversationRuns,
} from '../conversationView.js';
import { Button, Segmented } from './Ui.js';
import { Modal } from './Modal.js';
import { appIcons } from '../icons.js';
import { formatCharCount } from '../format.js';
import type { ConfigWebConversationItem } from '../../src/shared/types.js';
import type { ConversationFilter, TurnBlock, TurnStats } from '../conversationView.js';

const PAGE_SIZE = 80;

const SearchIcon = appIcons.search;

export function ConversationPane({ sessionId, refreshToken }: { sessionId: string; refreshToken: number }) {
  const [items, setItems] = useState<ConfigWebConversationItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ConversationFilter>('all');
  const [query, setQuery] = useState('');
  const [activeSequences, setActiveSequences] = useState<number[]>([]);
  const openRecords = (records: ConfigWebConversationItem[]) =>
    setActiveSequences(records.map((item) => item.sequence));
  const selected = new Set(activeSequences);
  const activeRecords = items.filter((item) => selected.has(item.sequence));
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

  /** 把最近一轮的段头对到视口顶部；没有段头（这一页全是上一轮的动作）时才滚到底。 */
  const scrollToLatestTurn = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const heads = scroll.querySelectorAll<HTMLElement>('.conversation-turn-head');
    const head = heads[heads.length - 1];
    if (!head) {
      scroll.scrollTop = scroll.scrollHeight;
      return;
    }
    scroll.scrollTop += head.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
  }, []);

  /**
   * 滚到最近一轮的段头，而不是滚到底。
   *
   * 按用户消息分轮之后，最新一页的开头常常是上一轮的工具尾巴；滚到底会让最近这句话
   * 正好被顶出视口，只剩半截工具行——打开详情最想看的恰恰是「我最后问的那句 + 它干了什么」。
   * 顺带保留原来的作用：顶部那条「加载更早」的哨兵不能留在视口里，否则会一口气翻完几百条。
   */
  useEffect(() => {
    if (scrolledToNewestRef.current || items.length === 0) return;
    scrolledToNewestRef.current = true;
    scrollToLatestTurn();
  }, [items.length, scrollToLatestTurn]);

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

  const blocks = useMemo(() => buildTurnBlocks(items), [items]);

  // 搜索先于类型筛选：筛选项上的数字是「在这个搜索词下各类型还有多少条」，
  // 点进去之前就知道有没有结果。
  const searched = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return items;
    return items.filter((item) => matchesConversationQuery(item, keyword));
  }, [items, query]);

  const counts = useMemo(() => {
    const next: Record<ConversationFilter, number> = { all: searched.length, talk: 0, tools: 0, thinking: 0 };
    for (const item of searched) next[conversationFilterOf(item)] += 1;
    return next;
  }, [searched]);

  const visible = useMemo(() => {
    const matched = new Set(searched.map((item) => item.sequence));
    const narrowed: TurnBlock[] = [];
    for (const block of blocks) {
      const records =
        filter === 'all'
          ? block.records.filter((item) => matched.has(item.sequence))
          : block.records.filter((item) => matched.has(item.sequence) && conversationFilterOf(item) === filter);
      const turn = block.turn && matched.has(block.turn.sequence) ? block.turn : null;
      if (!turn && records.length === 0) continue;
      narrowed.push({ ...block, turn, records });
    }
    return narrowed;
  }, [blocks, filter, searched]);

  const hasMore = items.length < total;
  const showIndividualRecords = filter !== 'all' || query.trim().length > 0;

  if (loading && items.length === 0) {
    // 首帧就把结构画出来（工具栏 + 滚动区），只是正文还没到：等第一条记录到达时
    // 只有内容出现，没有「小块居中文字 → 一整列卡片」这次几何跳变，看起来不闪。
    return (
      <div className="conversation-pane">
        <div className="session-pane-toolbar conversation-toolbar">
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
      <div className="session-pane-toolbar conversation-toolbar">
        <div className="conversation-toolbar-main">
          <Segmented
            size="compact"
            value={filter}
            ariaLabel="按类型筛选对话记录"
            options={CONVERSATION_FILTERS.map((entry) => ({
              value: entry.value,
              label: `${entry.label} ${counts[entry.value]}`,
            }))}
            onChange={(next) => setFilter(next as ConversationFilter)}
          />
          <label className="conversation-search">
            <SearchIcon size={13} aria-hidden="true" />
            <input
              type="search"
              value={query}
              aria-label="筛选对话记录内容"
              placeholder="筛选内容…"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
        <div className="session-pane-actions conversation-toolbar-tail">
          {/* 不筛选时不重复报总数：筛选条上已经写着载入多少，「加载更早」按钮写着 80 / 148。
              两处都写会在窄一点的窗口里把工具栏挤成两行。 */}
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
        </div>
      </div>

      {/* 工具栏固定在顶部（筛选 / 回到最新），只有记录本身滚动：滚到很上面时那一行
          「加载更早」正需要，跟着内容一起滚走就等于没有。 */}
      <div className="conversation-scroll" ref={scrollRef}>
        <div className="conversation-timeline">
          {hasMore ? (
            <div className="conversation-page-more" ref={sentinelRef}>
              {loadingMore ? (
                <span>正在加载更早的记录…</span>
              ) : (
                <Button fullWidth onClick={() => void loadEarlier()}>
                  加载更早（已显示 {items.length} / {total}）
                </Button>
              )}
            </div>
          ) : null}

          {visible.length === 0 ? (
            <div className="conversation-empty">
              <p>没有匹配的记录</p>
              <button
                type="button"
                className="ui-link-button"
                onClick={() => {
                  setFilter('all');
                  setQuery('');
                }}
              >
                清除筛选
              </button>
            </div>
          ) : null}

          {visible.map((block) => (
            <section
              key={block.key}
              className={`conversation-turn${block.turn ? '' : ' is-continuation'}`}
              aria-label={block.turn ? '一轮对话' : '上一轮未完的记录'}
            >
              {block.turn ? <TurnHead item={block.turn} stats={block.stats} onOpen={openRecords} /> : null}
              {showIndividualRecords
                ? block.records.map((item) => <RecordRow key={item.sequence} item={item} onOpen={openRecords} />)
                : splitConversationRuns(block.records).map((run) =>
                    run.kind === 'group' ? (
                      <RunRow key={run.key} records={run.records} onOpen={openRecords} />
                    ) : (
                      <RecordRow key={run.key} item={run.record} onOpen={openRecords} />
                    ),
                  )}
            </section>
          ))}

          {hasMore ? null : <div className="conversation-pane-end">— 已到最早记录 —</div>}
        </div>
      </div>
      {activeRecords.length > 0 ? (
        <ConversationDetailModal records={activeRecords} onClose={() => setActiveSequences([])} />
      ) : null}
    </div>
  );
}

type OpenRecords = (records: ConfigWebConversationItem[]) => void;

export function TurnHead({
  item,
  stats,
  onOpen,
}: {
  item: ConfigWebConversationItem;
  stats: TurnStats;
  onOpen: OpenRecords;
}) {
  const ChevronIcon = appIcons.chevronRight;
  const text = conversationPreview(item.content, 4000) || '(空)';

  return (
    <div className="conversation-turn-head">
      <button type="button" className="conversation-row-head" aria-haspopup="dialog" onClick={() => onOpen([item])}>
        <span className="conversation-seq">{item.sequence}</span>
        <span className="conversation-kind conversation-kind-user">你</span>
        <span className="conversation-turn-main">
          <span className="conversation-turn-text" title={text}>
            {text}
          </span>
          <span className="conversation-turn-stats" title={formatTurnStats(stats)}>
            {formatTurnStats(stats)}
          </span>
        </span>
        <span className="conversation-size" />
        <ChevronIcon className="conversation-chevron" size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

export function RecordRow({ item, onOpen }: { item: ConfigWebConversationItem; onOpen: OpenRecords }) {
  const ChevronIcon = appIcons.chevronRight;
  const prose = item.type === 'assistant' || item.type === 'reasoning';
  const preview = conversationPreview(item.content, prose ? 400 : 600);
  const chars = conversationItemSize(item);

  return (
    <div className={`conversation-row conversation-row-${item.type}`}>
      <button type="button" className="conversation-row-head" aria-haspopup="dialog" onClick={() => onOpen([item])}>
        <span className="conversation-seq">{item.sequence}</span>
        <span className={`conversation-kind conversation-kind-${conversationKindClass(item.type)}`}>
          {conversationItemLabel(item)}
        </span>
        <span className="conversation-main">
          {item.toolName ? (
            <span className="conversation-tool" title={item.toolName}>
              {item.toolName}
            </span>
          ) : null}
          <span className={`conversation-preview${prose ? ' is-prose' : ' is-code'}`} title={preview}>
            {preview}
          </span>
        </span>
        <span className="conversation-size" title={`${chars.toLocaleString()} 字符`}>
          {formatCharCount(chars)}
          <span className="conversation-size-unit"> 字符</span>
        </span>
        <ChevronIcon className="conversation-chevron" size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

export function RunRow({ records, onOpen }: { records: ConfigWebConversationItem[]; onOpen: OpenRecords }) {
  const ChevronIcon = appIcons.chevronRight;
  const first = records[0]!;
  const last = records[records.length - 1]!;
  const chars = records.reduce((sum, record) => sum + (record.sizeHint ?? record.content.length), 0);

  return (
    <div className="conversation-row conversation-run">
      <button type="button" className="conversation-row-head" aria-haspopup="dialog" onClick={() => onOpen(records)}>
        <span className="conversation-seq">
          {first.sequence}–{last.sequence}
        </span>
        <span className="conversation-kind conversation-kind-run">{conversationRunLabel(records)}</span>
        <span className="conversation-main">
          <span className="conversation-preview is-summary" title={describeConversationRun(records)}>
            {describeConversationRun(records)}
          </span>
        </span>
        <span className="conversation-size" title={`${chars.toLocaleString()} 字符`}>
          {formatCharCount(chars)}
          <span className="conversation-size-unit"> 字符</span>
        </span>
        <ChevronIcon className="conversation-chevron" size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

export function ConversationDetailModal({
  records,
  onClose,
}: {
  records: ConfigWebConversationItem[];
  onClose(): void;
}) {
  const first = records[0]!;
  const last = records[records.length - 1]!;
  const grouped = records.length > 1;
  const chars = records.reduce((sum, item) => sum + conversationItemSize(item), 0);

  return (
    <Modal
      portal
      wide
      title={`${grouped ? conversationRunLabel(records) : conversationItemLabel(first)} · #${first.sequence}${grouped ? `–${last.sequence}` : ''}`}
      onClose={onClose}
    >
      <div className="conversation-detail-summary">
        {grouped ? `${records.length} 条记录 · ` : ''}
        {chars.toLocaleString()} 字符
      </div>
      <div className="conversation-detail-records">
        {records.map((item) => (
          <section className="conversation-detail-record" key={item.sequence}>
            {grouped || item.toolName || item.callId ? (
              <div className="conversation-detail-meta">
                {grouped ? (
                  <span>
                    #{item.sequence} · {conversationItemLabel(item)}
                  </span>
                ) : null}
                {item.toolName ? <code>{item.toolName}</code> : null}
                {item.callId ? (
                  <span>
                    调用 <code>{item.callId}</code>
                  </span>
                ) : null}
              </div>
            ) : null}
            <pre className="conversation-content">{item.content || '(空)'}</pre>
          </section>
        ))}
      </div>
    </Modal>
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

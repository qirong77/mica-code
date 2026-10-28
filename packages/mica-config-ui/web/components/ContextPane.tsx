import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { readSessionContextAnalysis, readSessionItem } from '../api.js';
import {
  CONTEXT_KIND_LABELS,
  CONTEXT_KIND_ORDER,
  OVERHEAD_LABEL,
  bodyOverInputNote,
  contextBarSegments,
  contextItemCounts,
  contextItemSubtitle,
  contextItemTitle,
  contextKindClass,
  contextTotalTokens,
  filterContextItems,
  formatShare,
  formatTokens,
  overheadNote,
  sortContextItems,
  staleReferenceNote,
} from '../contextView.js';
import { Modal } from './Modal.js';
import { Tag } from './Ui.js';
import type {
  ConfigWebContextAnalysis,
  ConfigWebContextItem,
  ConfigWebContextKind,
  ConfigWebContextTurn,
  ConfigWebConversationItemType,
} from '../../src/shared/types.js';

/** 一次渲染 50 条，避免上千条消息一次进 DOM。 */
const RENDER_STEP = 50;

/**
 * Context 分析：先说清「谁占了 context」，再给能翻到单条的明细。
 *
 * 顶部是分类占比（堆叠条 + 类别表），中间是逐条消息（按体积或顺序、可按类别过滤），
 * 底部折叠着按轮次的走势——这三块回答的是同一个问题的三个粒度，所以放在同一个页签里，
 * 而不是再各开一个入口。
 */
export function ContextPane({ sessionId, refreshToken }: { sessionId: string; refreshToken: number }) {
  const [analysis, setAnalysis] = useState<ConfigWebContextAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTurn, setActiveTurn] = useState<ConfigWebContextTurn | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    readSessionContextAnalysis(sessionId)
      .then((next) => {
        if (!cancelled) setAnalysis(next);
      })
      .catch((loadError) => {
        if (!cancelled) setError(formatError(loadError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshToken]);

  if (loading && !analysis) return <div className="session-loading">正在分析上下文…</div>;
  if (error && !analysis) return <div className="ui-alert">{error}</div>;
  if (!analysis) return null;

  const total = contextTotalTokens(analysis);

  return (
    <div className="context-pane">
      <ContextOverview analysis={analysis} total={total} />
      <ContextCategoryTable analysis={analysis} total={total} />
      <ContextEstimateNote analysis={analysis} />
      <ContextItemList items={analysis.items} total={total} />
      <ContextTurnList
        analysis={analysis}
        activeTurn={activeTurn}
        onOpenTurn={setActiveTurn}
      />
      {activeTurn ? (
        <TurnModal sessionId={sessionId} turn={activeTurn} onClose={() => setActiveTurn(null)} />
      ) : null}
    </div>
  );
}

function ContextOverview({ analysis, total }: { analysis: ConfigWebContextAnalysis; total: number }) {
  const segments = contextBarSegments(analysis);
  const staleNote = staleReferenceNote(analysis);
  const bodyNote = bodyOverInputNote(analysis);
  return (
    <section className="context-overview simple-card">
      {segments.length > 0 && total > 0 ? (
        <>
          <div className="context-stacked-bar" role="img" aria-label="上下文占用构成">
            {segments.map((segment) => (
              <span
                key={segment.key}
                className={`context-seg ${contextKindClass(segment.kind)}`}
                style={{ flexGrow: Math.max(segment.tokens, 1), flexBasis: 0 }}
                title={`${segment.label} · ~${formatTokens(segment.tokens)} tokens · ${formatShare(segment.tokens, total)}`}
              />
            ))}
          </div>
          <div className="context-legend">
            {segments.map((segment) => (
              <span key={segment.key}>
                <i className={`context-dot ${contextKindClass(segment.kind)}`} />
                {segment.label}
                <em>{formatTokens(segment.tokens)}</em>
                <small>{formatShare(segment.tokens, total)}</small>
              </span>
            ))}
          </div>
        </>
      ) : null}

      <div className="context-facts">
        <span>
          持久化消息体 ~<strong>{formatTokens(analysis.messageTokens)}</strong> tokens（
          {analysis.items.length} 条）
        </span>
        {analysis.lastInputTokens > 0 ? (
          <span>最近一次请求 input {analysis.lastInputTokens.toLocaleString()}</span>
        ) : null}
        {analysis.staleInput?.compactedTokens ? (
          <span>压缩后估算 ~{formatTokens(analysis.staleInput.compactedTokens)}</span>
        ) : null}
        {analysis.contextWindowSize ? (
          <span>窗口 {formatTokens(analysis.contextWindowSize)}</span>
        ) : null}
      </div>

      {staleNote ? <p className="context-note context-note-warn">{staleNote}</p> : null}
      {bodyNote ? <p className="context-note">{bodyNote}</p> : null}
    </section>
  );
}

function ContextCategoryTable({ analysis, total }: { analysis: ConfigWebContextAnalysis; total: number }) {
  const rows = analysis.categories;
  const overhead = analysis.overheadTokens;
  if (rows.length === 0 && overhead <= 0) return null;
  const maxTokens = Math.max(1, ...rows.map((row) => row.tokens), overhead);
  const overheadNoteText = overheadNote(analysis);

  return (
    <section className="context-categories simple-card">
      <div className="context-section-head">
        <h3>占用来源</h3>
        <span className="muted-text">最近一次请求 input 与消息体估算同一张表</span>
      </div>
      <table className="context-table">
        <thead>
          <tr>
            <th scope="col">来源</th>
            <th scope="col" className="is-num">
              条数
            </th>
            <th scope="col" className="is-num">
              估算 tokens
            </th>
            <th scope="col">占比</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.kind}>
              <td>
                <span className={`context-badge ${contextKindClass(row.kind)}`}>
                  {CONTEXT_KIND_LABELS[row.kind]}
                </span>
              </td>
              <td className="is-num muted-text">{row.count}</td>
              <td className="is-num">{row.tokens.toLocaleString()}</td>
              <td>
                <span className="context-share">
                  <span className="context-share-track">
                    <i
                      className={contextKindClass(row.kind)}
                      style={{ width: `${(row.tokens / maxTokens) * 100}%` }}
                    />
                  </span>
                  <em>{formatShare(row.tokens, total)}</em>
                </span>
              </td>
            </tr>
          ))}
          {overhead > 0 ? (
            <tr>
              <td>
                <span className="context-badge context-kind-overhead">{OVERHEAD_LABEL}</span>
              </td>
              <td className="is-num muted-text">—</td>
              <td className="is-num">{overhead.toLocaleString()}</td>
              <td>
                <span className="context-share">
                  <span className="context-share-track">
                    <i
                      className="context-kind-overhead"
                      style={{ width: `${(overhead / maxTokens) * 100}%` }}
                    />
                  </span>
                  <em>{formatShare(overhead, total)}</em>
                </span>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {overheadNoteText ? <p className="context-note context-note-warn">{overheadNoteText}</p> : null}
    </section>
  );
}

/** 口径说明：一次性读完就不会再问「为什么和真实 token 对不上」。 */
function ContextEstimateNote({ analysis }: { analysis: ConfigWebContextAnalysis }) {
  return (
    <details className="context-estimate simple-card">
      <summary>
        <span>口径说明</span>
        <span className="muted-text">chars/4 估算、差额从哪来、媒体块怎么算</span>
      </summary>
      <div className="context-estimate-body">
        <p>
          所有数字都是「持久化消息体」的估算：`chars / 4`，与 CLI 状态栏的 ctx 同口径。
          「{OVERHEAD_LABEL}」= 最近一次请求的 input 减去持久化消息体估算，包含 system prompt、
          AGENT.md、skills 索引、全部工具 schema、不落盘的思考内容（Responses
          的加密推理链），以及 chars/4 与真实 tokenize 的差（JSON 结构、id、中文都会让实际更贵）。
        </p>
        <p>
          「消息结构（信封）」是每条消息的 role / type / call_id / name
          等结构字段，线上请求同样会带上（压缩与状态栏的估算按带缩进的整份历史 JSON
          口径，与这里的逐条口径会差一成左右）。媒体块（图片 / 文档）只记张数、不计字符
          （base64 长度与 vision token 无关）。
        </p>
        <p>
          {analysis.clearedResults > 0
            ? `有 ${analysis.clearedResults} 条工具结果在 compact 时被清理成占位符，它们的体积已经很小。`
            : '当前没有在 compact 时被清理的工具结果。'}
        </p>
      </div>
    </details>
  );
}

function ContextItemList({ items, total }: { items: ConfigWebContextItem[]; total: number }) {
  const [visible, setVisible] = useState(RENDER_STEP);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [filter, setFilter] = useState<ConfigWebContextKind | 'all'>('all');
  const [sort, setSort] = useState<'size' | 'order'>('size');

  const counts = useMemo(() => contextItemCounts(items), [items]);
  const rows = useMemo(() => sortContextItems(filterContextItems(items, filter), sort), [items, filter, sort]);

  if (items.length === 0) return null;

  const filterOptions: { key: ConfigWebContextKind | 'all'; label: string; count: number }[] = [
    { key: 'all', label: '全部', count: items.length },
    ...CONTEXT_KIND_ORDER.filter((kind) => (counts.get(kind) ?? 0) > 0).map((kind) => ({
      key: kind,
      label: CONTEXT_KIND_LABELS[kind],
      count: counts.get(kind) ?? 0,
    })),
  ];

  return (
    <section className="context-items simple-card">
      <div className="context-section-head">
        <h3>逐条明细</h3>
        <span className="muted-text">按体积排序，点开可看内容与体积</span>
      </div>

      <div className="context-item-filters">
        {filterOptions.map((option) => (
          <button
            key={option.key}
            type="button"
            className={`context-filter${filter === option.key ? ' is-active' : ''}`}
            onClick={() => {
              setFilter(option.key);
              setVisible(RENDER_STEP);
              setExpanded(null);
            }}
          >
            {option.label}
            <span>{option.count}</span>
          </button>
        ))}
        <button
          type="button"
          className="context-filter context-filter-sort"
          onClick={() => {
            setSort(sort === 'size' ? 'order' : 'size');
            setExpanded(null);
          }}
        >
          排序：{sort === 'size' ? '体积 ↓' : '对话顺序'}
        </button>
      </div>

      <div className="context-item-list">
        {rows.slice(0, visible).map((item) => {
          const open = expanded === item.sequence;
          const subtitle = contextItemSubtitle(item);
          return (
            <div key={item.sequence} className="context-item">
              <button
                type="button"
                className="context-item-row"
                aria-expanded={open}
                onClick={() => setExpanded(open ? null : item.sequence)}
              >
                <span className="context-item-seq">#{item.sequence}</span>
                <span className={`context-badge ${contextKindClass(item.kind)}`}>
                  {CONTEXT_KIND_LABELS[item.kind]}
                </span>
                <span className="context-item-title" title={contextItemTitle(item)}>
                  {contextItemTitle(item)}
                </span>
                {subtitle ? (
                  <span className="context-item-subtitle" title={subtitle}>
                    {subtitle}
                  </span>
                ) : null}
                <span className="context-item-tokens">~{formatTokens(item.tokens)}</span>
                <span className="context-item-share">{formatShare(item.tokens, total)}</span>
                <span className="context-item-chevron" aria-hidden="true">
                  {open ? '−' : '+'}
                </span>
              </button>
              {open ? (
                <div className="context-item-detail">
                  <div className="context-item-metrics">
                    <span>估算 ~{item.tokens.toLocaleString()} tokens</span>
                    <span>{item.chars.toLocaleString()} chars</span>
                    {item.name ? <span>{item.name}</span> : null}
                    {item.toolCallId ? <span>{item.toolCallId}</span> : null}
                    {item.encryptedChars ? (
                      <span>加密推理链 {formatTokens(item.encryptedChars)} chars</span>
                    ) : null}
                  </div>
                  {item.content ? (
                    <pre className="context-item-content">{item.content}</pre>
                  ) : (
                    <div className="context-item-empty">
                      {item.cleared ? '内容已在 compact 时清理为占位符' : '无正文（仅结构）'}
                    </div>
                  )}
                  {item.toolCalls && item.toolCalls.length > 0 ? (
                    <div className="context-item-calls">
                      {item.toolCalls.map((call, index) => (
                        <div key={call.id ?? index} className="context-item-call">
                          <div className="context-item-call-name">{call.name || 'tool_call'}</div>
                          {call.arguments ? <pre>{call.arguments}</pre> : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {rows.length > visible ? (
        <button
          type="button"
          className="ui-button context-load-more"
          onClick={() => setVisible((value) => value + RENDER_STEP)}
        >
          显示更多（{rows.length - visible} 条）
        </button>
      ) : null}
    </section>
  );
}

function ContextTurnList({
  analysis,
  activeTurn,
  onOpenTurn,
}: {
  analysis: ConfigWebContextAnalysis;
  activeTurn: ConfigWebContextTurn | null;
  onOpenTurn(turn: ConfigWebContextTurn): void;
}) {
  if (analysis.turns.length === 0) return null;
  const peak = Math.max(0, ...analysis.turns.flatMap((turn) => turn.contextTokens ?? []));
  const window = analysis.contextWindowSize;
  const pct = window && peak > 0 ? peak / window : null;
  return (
    <details className="context-turns simple-card">
      <summary>
        <span>按轮次的走势</span>
        <span className="muted-text">
          {analysis.turnCount} 轮
          {pct !== null ? ` · 峰值 ${formatTokens(peak)}（${Math.round(pct * 100)}% / ${formatTokens(window ?? 0)}）` : ''}
        </span>
      </summary>
      <div className="context-turn-list">
        {analysis.turns.map((turn) => (
          <TurnRow
            key={turn.index}
            turn={turn}
            active={activeTurn?.index === turn.index}
            onClick={() => onOpenTurn(turn)}
          />
        ))}
      </div>
    </details>
  );
}

function TurnRow({
  turn,
  active,
  onClick,
}: {
  turn: ConfigWebContextTurn;
  active: boolean;
  onClick(): void;
}) {
  const largest = Math.max(1, turn.totalTokens);
  const segments = [
    { type: 'conversation' as const, value: turn.conversationTokens },
    { type: 'tools' as const, value: turn.toolTokens },
    { type: 'thinking' as const, value: turn.thinkingTokens },
  ];
  return (
    <button type="button" className={`context-turn-row${active ? ' is-active' : ''}`} onClick={onClick}>
      <span className="context-turn-index">T{turn.index}</span>
      <span className="context-turn-copy">
        <span className="context-turn-preview" title={turn.userPreview}>
          {turn.userPreview || '(无用户消息)'}
        </span>
        <span className="context-turn-bar-row">
          <span className="context-mini-bar">
            {segments.map((segment) =>
              segment.value > 0 ? (
                <span
                  key={segment.type}
                  className={`context-seg context-seg-${segment.type}`}
                  style={{ width: `${(segment.value / largest) * 100}%` }}
                />
              ) : null,
            )}
          </span>
          <span className="context-turn-tokens">
            对话 {formatTokens(turn.conversationTokens)} · 工具 {formatTokens(turn.toolTokens)} · 思考{' '}
            {formatTokens(turn.thinkingTokens)}
            {turn.contextTokens !== undefined ? ` · 实际 ${formatTokens(turn.contextTokens)}` : ''}
          </span>
        </span>
      </span>
      <span className="context-turn-chevron">›</span>
    </button>
  );
}

function TurnModal({
  sessionId,
  turn,
  onClose,
}: {
  sessionId: string;
  turn: ConfigWebContextTurn;
  onClose(): void;
}) {
  return (
    <Modal
      wide
      title={
        <span>
          Turn {turn.index} 上下文明细
          <span className="modal-title-sub">{formatTokens(turn.totalTokens)} tokens（估算）</span>
        </span>
      }
      onClose={onClose}
    >
      <div className="context-detail-summary">
        <p className="context-detail-prompt">{turn.userPreview || '(无用户消息)'}</p>
        <div className="toolbar">
          <Tag tone="blue">对话 {formatTokens(turn.conversationTokens)}</Tag>
          <Tag tone="green">工具 {formatTokens(turn.toolTokens)}</Tag>
          <Tag>思考 {formatTokens(turn.thinkingTokens)}</Tag>
          {turn.contextTokens !== undefined ? (
            <Tag tone="red">实际输入 {formatTokens(turn.contextTokens)}</Tag>
          ) : null}
          {turn.usageRequests > 0 ? <span className="muted-text">{turn.usageRequests} 次请求</span> : null}
        </div>
      </div>
      <div className="context-entry-list">
        {turn.entries.map((entry) => (
          <ContextEntryRow
            key={entry.sequence}
            sessionId={sessionId}
            entry={entry}
            maxTokens={turn.totalTokens}
          />
        ))}
      </div>
    </Modal>
  );
}

function ContextEntryRow({
  sessionId,
  entry,
  maxTokens,
}: {
  sessionId: string;
  entry: ConfigWebContextTurn['entries'][number];
  maxTokens: number;
}) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || full !== null || loading) return;
    let cancelled = false;
    setLoading(true);
    readSessionItem(sessionId, entry.sequence)
      .then((item) => {
        if (!cancelled) setFull(item.content || '(empty)');
      })
      .catch(() => {
        if (!cancelled) setFull('(加载失败)');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, full, loading, sessionId, entry.sequence]);

  const pct = entry.tokens > 0 && maxTokens > 0 ? (entry.tokens / maxTokens) * 100 : 0;

  return (
    <div className="context-entry">
      <button
        type="button"
        className={`context-entry-header context-entry-bar-${entryBarKind(entry.type)}`}
        style={pct > 0 ? ({ '--entry-bar-pct': `${pct}%` } as CSSProperties) : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="context-entry-seq">#{entry.sequence}</span>
        <Tag tone={entryTone(entry.type)}>
          {entry.type === 'tool_call' || entry.type === 'tool_result' ? entry.label : entryLabel(entry)}
        </Tag>
        <span className="context-entry-preview" title={entry.preview}>
          {entry.preview}
        </span>
        <span className="context-entry-tokens">{formatTokens(entry.tokens)}</span>
        {entry.images ? <span className="context-entry-images">{entry.images} 图</span> : null}
        <span className="context-entry-chevron">{open ? '−' : '+'}</span>
      </button>
      {open ? <pre className="context-entry-content">{loading ? '加载中…' : (full ?? entry.preview)}</pre> : null}
    </div>
  );
}

function entryLabel(entry: ConfigWebContextTurn['entries'][number]): string {
  if (entry.type === 'reasoning') return '思考';
  if (entry.type === 'tool_call') return '工具调用';
  if (entry.type === 'tool_result') return '工具结果';
  if (entry.type === 'assistant') return 'LLM 回复';
  if (entry.type === 'user') return '用户';
  if (entry.type === 'system') return '系统提示';
  return entry.label;
}

function entryTone(type: ConfigWebConversationItemType): 'default' | 'green' | 'red' | 'blue' {
  if (type === 'user' || type === 'system') return 'blue';
  if (type === 'assistant') return 'green';
  if (type === 'tool_result') return 'red';
  return 'default';
}

function entryBarKind(type: ConfigWebConversationItemType): 'conversation' | 'tools' | 'thinking' {
  if (type === 'reasoning') return 'thinking';
  if (type === 'tool_call' || type === 'tool_result') return 'tools';
  return 'conversation';
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

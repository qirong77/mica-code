import { useEffect, useState, type CSSProperties } from 'react';
import { readSessionContextAnalysis, readSessionItem } from '../api.js';
import { Modal } from './Modal.js';
import { Tag } from './Ui.js';
import type {
  ConfigWebContextAnalysis,
  ConfigWebContextEntry,
  ConfigWebContextTurn,
  ConfigWebConversationItemType,
} from '../../../src/shared/types.js';

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

  const { totals } = analysis;
  const largest = Math.max(1, totals.totalTokens);
  const lastUsage = analysis.turns.flatMap((turn) => turn.contextTokens).filter((v) => v !== undefined);
  const maxContextTokens = lastUsage.length > 0 ? Math.max(...lastUsage) : 0;
  const contextWindow = analysis.contextWindowSize;
  const contextPct = contextWindow && maxContextTokens > 0 ? maxContextTokens / contextWindow : null;

  return (
    <div className="context-pane">
      <section className="context-overview simple-card">
        <div className="context-overview-row">
          <div className="context-total-card">
            <span>对话</span>
            <strong>{formatTokens(totals.conversationTokens)}</strong>
          </div>
          <div className="context-total-card">
            <span>工具</span>
            <strong>{formatTokens(totals.toolTokens)}</strong>
          </div>
          <div className="context-total-card">
            <span>思考</span>
            <strong>{formatTokens(totals.thinkingTokens)}</strong>
          </div>
          <div className="context-total-card context-total-card-main">
            <span>总计（估算）</span>
            <strong>{formatTokens(totals.totalTokens)}</strong>
          </div>
          <div className="context-total-card">
            <span>轮次 / 图片</span>
            <strong>
              {analysis.turnCount} / {analysis.imageCount}
            </strong>
          </div>
        </div>

        <div className="context-stacked-bar" role="img" aria-label="上下文构成占比">
          <span
            className="context-seg context-seg-conversation"
            style={{ width: `${(totals.conversationTokens / largest) * 100}%` }}
            title={`对话 ${formatTokens(totals.conversationTokens)}`}
          />
          <span
            className="context-seg context-seg-tools"
            style={{ width: `${(totals.toolTokens / largest) * 100}%` }}
            title={`工具 ${formatTokens(totals.toolTokens)}`}
          />
          <span
            className="context-seg context-seg-thinking"
            style={{ width: `${(totals.thinkingTokens / largest) * 100}%` }}
            title={`思考 ${formatTokens(totals.thinkingTokens)}`}
          />
        </div>

        <div className="context-legend">
          <span>
            <i className="context-dot context-seg-conversation" /> 对话
          </span>
          <span>
            <i className="context-dot context-seg-tools" /> 工具
          </span>
          <span>
            <i className="context-dot context-seg-thinking" /> 思考
          </span>
          {contextPct !== null ? (
            <span className="context-usage-note">
              实际上下文峰值 <strong>{formatTokens(maxContextTokens)}</strong>（{Math.round(contextPct * 100)}% /{' '}
              {formatTokens(contextWindow ?? 0)}）
            </span>
          ) : null}
          <span className="context-estimate-note">* Token 为估算值，点击轮次查看明细</span>
        </div>
      </section>

      {analysis.turns.length === 0 ? (
        <div className="ui-empty">该会话没有可分析的对话内容</div>
      ) : (
        <section className="context-turns simple-card">
          <div className="context-turns-header">
            <h3>按时间顺序的上下文构成</h3>
            <span className="muted-text">对话 / 工具 / 思考 每轮 token 占比</span>
          </div>
          <div className="context-turn-list">
            {analysis.turns.map((turn) => (
              <TurnRow key={turn.index} turn={turn} onClick={() => setActiveTurn(turn)} />
            ))}
          </div>
        </section>
      )}

      {activeTurn ? <TurnModal sessionId={sessionId} turn={activeTurn} onClose={() => setActiveTurn(null)} /> : null}
    </div>
  );
}

function TurnRow({ turn, onClick }: { turn: ConfigWebContextTurn; onClick(): void }) {
  const largest = Math.max(1, turn.totalTokens);
  const segments = [
    { type: 'conversation' as const, value: turn.conversationTokens },
    { type: 'tools' as const, value: turn.toolTokens },
    { type: 'thinking' as const, value: turn.thinkingTokens },
  ];
  return (
    <button type="button" className="context-turn-row" onClick={onClick}>
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

function TurnModal({ sessionId, turn, onClose }: { sessionId: string; turn: ConfigWebContextTurn; onClose(): void }) {
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
          {turn.contextTokens !== undefined ? <Tag tone="red">实际输入 {formatTokens(turn.contextTokens)}</Tag> : null}
          {turn.usageRequests > 0 ? <span className="muted-text">{turn.usageRequests} 次请求</span> : null}
        </div>
      </div>
      <div className="context-entry-list">
        {turn.entries.map((entry) => (
          <ContextEntryRow key={entry.sequence} sessionId={sessionId} entry={entry} maxTokens={turn.totalTokens} />
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
  entry: ConfigWebContextEntry;
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

function entryLabel(entry: ConfigWebContextEntry): string {
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

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

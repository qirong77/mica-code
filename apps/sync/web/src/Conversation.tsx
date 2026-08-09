import { memo, useEffect, useRef, useState } from 'react';
import {
  contextUsage,
  formatElapsedMs,
  formatTokens,
  modelLabel,
  toolIcon,
  toolLabel,
} from '@packages/mica-web-shared/index.js';
import type { MachineInfo, StoredSession } from './api';
import { CwdPicker } from './CwdPicker';
import { formatTime } from './format';
import { appIcons } from './icons';
import { Markdown } from './Markdown';
import type { UiMessage } from './render';

type ConversationProps = {
  machine: MachineInfo;
  session: StoredSession;
  messages: UiMessage[];
  running: boolean;
  connected: boolean;
  connecting: boolean;
  usage?: StoredSession['snapshot']['lastUsage'];
  cwdCandidates: string[];
  cwdSwitching: boolean;
  cwdError: string;
  onSend: (text: string) => void;
  onAbort: () => void;
  onSelectCwd: (cwd: string) => void;
  onOpenSidebar: () => void;
};

const ToolCard = memo(function ToolCard({ message }: { message: Extract<UiMessage, { kind: 'tool' }> }) {
  const [expanded, setExpanded] = useState(false);
  const LoaderIcon = appIcons.loader;
  const ChevronDownIcon = appIcons.chevronDown;
  const ChevronRightIcon = appIcons.chevronRight;
  const running = message.state === 'running';
  const failed = message.state === 'error';
  const statusClass = running ? 'running' : failed ? 'error' : 'complete';

  let argsPreview = '';
  try {
    const parsed = JSON.parse(message.args) as Record<string, unknown>;
    argsPreview = Object.entries(parsed)
      .slice(0, 3)
      .map(([key, value]) => `${key}: ${typeof value === 'string' ? truncate(value, 60) : JSON.stringify(value)}`)
      .join(' · ');
  } catch {
    argsPreview = truncate(message.args, 80);
  }

  return (
    <div className={`chat-tool-card ${statusClass}`} onClick={() => setExpanded((value) => !value)}>
      <div className="chat-tool-card-row">
        {running && (
          <span className="chat-tool-spinner">
            <LoaderIcon size={10} className="spin" />
          </span>
        )}
        <span className="chat-tool-icon">{toolIcon(message.name)}</span>
        <span className="chat-tool-display">
          {toolLabel(message.name)}
          {argsPreview && <span className="chat-tool-args"> {argsPreview}</span>}
        </span>
        {typeof message.durationMs === 'number' && (
          <span className="chat-tool-duration">
            {running ? formatElapsedMs(message.durationMs) : `(${formatElapsedMs(message.durationMs)})`}
          </span>
        )}
        <span className="chat-tool-expand">
          {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        </span>
      </div>
      {expanded && (
        <div className="chat-tool-body">
          {message.args && (
            <details open>
              <summary>参数</summary>
              <pre className="chat-tool-json">{message.args}</pre>
            </details>
          )}
          {message.result !== undefined && (
            <details open={failed}>
              <summary>结果{failed ? '（失败）' : ''}</summary>
              <pre className={`chat-tool-result ${failed ? 'error' : ''}`}>{message.result}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
});

const THINKING_PREVIEW_MAX = 80;
const THINKING_PREVIEW_DEBOUNCE_MS = 300;

/**
 * Snapshots saved by older mica processes lack `contextWindowSize`. Estimate
 * it from a small table of known models, falling back to the primary
 * deployment model's window (deepseek-v4-flash, 1M) so ctx% still renders.
 */
const KNOWN_CONTEXT_WINDOW: Record<string, number> = {
  'deepseek-v4-flash': 1_000_000,
};
const FALLBACK_CONTEXT_WINDOW = 1_000_000;

function effectiveContextWindow(model: string, snapshotSize: number | undefined): number {
  if (typeof snapshotSize === 'number' && snapshotSize > 0) return snapshotSize;
  return KNOWN_CONTEXT_WINDOW[model] ?? FALLBACK_CONTEXT_WINDOW;
}

const ThinkingBlock = memo(function ThinkingBlock({ message }: { message: Extract<UiMessage, { kind: 'thinking' }> }) {
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState(() => message.text.slice(0, THINKING_PREVIEW_MAX));
  const SparklesIcon = appIcons.sparkles;
  const ChevronDownIcon = appIcons.chevronDown;
  const ChevronRightIcon = appIcons.chevronRight;

  // 流式增量频繁到达时，摘要延迟更新，避免每块 delta 都跳变（闪烁）。
  // 思考段停止推送约 300ms 后摘要才稳定到最终内容。
  useEffect(() => {
    const timer = setTimeout(
      () => setPreview(message.text.slice(0, THINKING_PREVIEW_MAX)),
      THINKING_PREVIEW_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [message.text]);

  const truncated = message.text.length > THINKING_PREVIEW_MAX;
  const summary = expanded ? `思考 · ${message.text.length} 字` : preview || '思考中…';
  return (
    <div className={`chat-thinking ${expanded ? 'expanded' : ''}`}>
      <button className="chat-thinking-toggle" onClick={() => setExpanded((value) => !value)}>
        <span className="chat-thinking-icon">
          <SparklesIcon size={12} />
        </span>
        <span className="chat-thinking-summary">
          {summary}
          {!expanded && truncated ? '…' : ''}
        </span>
        <span className="chat-thinking-expand">
          {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        </span>
      </button>
      {expanded && <div className="chat-thinking-text">{message.text}</div>}
    </div>
  );
});

const MessageItem = memo(function MessageItem({ message }: { message: UiMessage }) {
  if (message.kind === 'user') {
    return (
      <div className="chat-message chat-message-user">
        <span className="chat-message-marker">▌</span>
        <div className="chat-message-body whitespace-pre-wrap break-words">{message.text}</div>
        <span className="chat-message-time">{formatTime(new Date(message.ts).toISOString())}</span>
      </div>
    );
  }
  if (message.kind === 'assistant') {
    return (
      <div className="chat-message chat-message-assistant">
        <span className="chat-message-marker">●</span>
        <div className="chat-message-body">
          <Markdown text={message.text} />
        </div>
        <span className="chat-message-time">{formatTime(new Date(message.ts).toISOString())}</span>
      </div>
    );
  }
  if (message.kind === 'tool') return <ToolCard message={message} />;
  if (message.kind === 'thinking') return <ThinkingBlock message={message} />;
  return (
    <div className={`chat-notice ${message.variant === 'error' ? 'chat-notice-error' : ''}`}>
      <span>▌</span>
      <div className="chat-notice-body">{message.text}</div>
    </div>
  );
});

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export const Conversation = memo(function Conversation({
  machine,
  session,
  messages,
  running,
  connected,
  connecting,
  usage,
  cwdCandidates,
  cwdSwitching,
  cwdError,
  onSend,
  onAbort,
  onSelectCwd,
  onOpenSidebar,
}: ConversationProps) {
  const [draft, setDraft] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(0);
  const startedAtRef = useRef<number | null>(null);

  // 终端在跑同一 session（快照 turnState === 'running'），与 daemon 远程运行区分开。
  const localRunning = session.turnState === 'running';
  const busy = running || localRunning;

  useEffect(() => {
    if (!running && !localRunning) inputRef.current?.focus();
  }, [running, localRunning]);

  // 远程 turn 运行耗时：running 变 true 时起算，每秒刷新（对齐 desktop 状态栏）。
  useEffect(() => {
    if (!running) {
      startedAtRef.current = null;
      setElapsed(0);
      return;
    }
    startedAtRef.current = startedAtRef.current ?? Date.now();
    const timer = setInterval(() => {
      const start = startedAtRef.current;
      if (start) setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [running]);

  // 消息流从上往下排列；初始加载完成或用户接近底部时自动滚到最新消息。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const loadedFresh = messages.length > 0 && prevCountRef.current === 0;
    prevCountRef.current = messages.length;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (loadedFresh || nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages, running]);

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    onSend(text);
  };

  const snapshot = session.snapshot ?? {};
  const model = snapshot.model || '';
  const effort = snapshot.effort && snapshot.effort !== 'none' ? snapshot.effort : undefined;
  const modelName = modelLabel(model, effort);
  const context = contextUsage({
    usage: usage ?? snapshot.lastUsage,
    model,
    contextWindowSize: effectiveContextWindow(model, snapshot.contextWindowSize),
  });
  const MenuIcon = appIcons.menu;
  const SendIcon = appIcons.send;
  const SquareIcon = appIcons.square;

  return (
    <main className="conversation">
      <header className="conversation-header">
        <div className="conversation-title-row">
          <button className="menu-button" onClick={onOpenSidebar} title="机器与会话" aria-label="打开机器与会话列表">
            <MenuIcon size={18} />
          </button>
          <h1 className="conversation-title">{session.title}</h1>
          {running && (
            <span className="live-badge">
              <span className="live-dot" />
              远程运行中
              {elapsed > 0 && <span className="elapsed">· {formatElapsedMs(elapsed * 1000)}</span>}
            </span>
          )}
          {!running && localRunning && (
            <span className="live-badge local">
              <span className="live-dot" />
              本机运行中
            </span>
          )}
          <span
            className={`conn-dot ${connected ? 'ok' : connecting ? 'connecting' : 'lost'}`}
            title={connected ? '实时连接' : connecting ? '连接中…' : '连接断开，自动重连中…'}
            aria-label="连接状态"
          />
        </div>
      </header>

      <div className="messages-scroll" ref={scrollRef}>
        <div className="messages">
          {messages.length === 0 && <div className="empty-hint">这个会话还没有消息</div>}
          {messages.map((message) => (
            <MessageItem key={message.id} message={message} />
          ))}
          {running && (
            <div className="running-indicator">
              <span className="spinner" />
              正在思考…
            </div>
          )}
        </div>
      </div>

      <div className="input-area">
        <div className="chat-status-line">
          <span className="chat-status-primary">
            <span className="meta-machine" title={machine.hostname}>
              {machine.name}
            </span>
            {modelName && (
              <>
                <span className="composer-separator">·</span>
                <span className="meta-model" title={modelName}>
                  {modelName}
                </span>
              </>
            )}
            {context && (
              <>
                <span className="composer-separator">·</span>
                <span className="meta-context">
                  <span className="ctx-tokens">{formatTokens(context.tokens)}</span>
                  <span className="ctx-sep"> (cached </span>
                  <span className="ctx-cached">{context.cachedPct}%</span>
                  <span className="ctx-sep">, ctx </span>
                  <span className={`ctx-pct ${context.tone}`}>{context.contextPct}%</span>
                  <span className="ctx-sep">)</span>
                </span>
              </>
            )}
          </span>
          <span className="chat-status-meta">
            {!connected && (
              <span className={`conn-text ${connecting ? 'connecting' : 'lost'}`}>
                {connecting ? '连接中…' : '连接断开，自动重连中…'}
              </span>
            )}
          </span>
        </div>
        <textarea
          ref={inputRef}
          value={draft}
          placeholder={
            running ? '远程任务运行中…' : localRunning ? '本机终端正在运行…' : '继续对话，Enter 发送，Shift+Enter 换行'
          }
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          disabled={busy}
          rows={3}
        />
        <div className="input-actions">
          <span className="input-hint">{draft.length > 0 ? `${draft.length} 字` : ' '}</span>
          <CwdPicker
            cwd={session.cwd}
            candidates={cwdCandidates}
            switching={cwdSwitching}
            error={cwdError}
            onChange={onSelectCwd}
          />
          {running ? (
            <button className="abort-button" onClick={onAbort}>
              <SquareIcon size={12} />
              中止
            </button>
          ) : (
            <button className="send-button" onClick={send} disabled={!draft.trim() || busy}>
              <SendIcon size={14} />
              发送
            </button>
          )}
        </div>
      </div>
    </main>
  );
});

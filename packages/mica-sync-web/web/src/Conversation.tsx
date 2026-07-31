import { memo, useEffect, useRef, useState } from 'react';
import type { MachineInfo, StoredSession } from './api';
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
  onSend: (text: string) => void;
  onAbort: () => void;
  onOpenSidebar: () => void;
};

const ToolCard = memo(function ToolCard({ message }: { message: Extract<UiMessage, { kind: 'tool' }> }) {
  const [expanded, setExpanded] = useState(false);
  const LoaderIcon = appIcons.loader;
  const CheckIcon = appIcons.check;
  const XIcon = appIcons.x;
  const ChevronDownIcon = appIcons.chevronDown;
  const ChevronRightIcon = appIcons.chevronRight;
  const stateIcon =
    message.state === 'running' ? (
      <LoaderIcon size={13} className="spin" />
    ) : message.state === 'done' ? (
      <CheckIcon size={13} />
    ) : (
      <XIcon size={13} />
    );
  const stateClass = `tool-state ${message.state}`;
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
    <div className="tool-card" onClick={() => setExpanded((value) => !value)} title={expanded ? '收起' : '展开'}>
      <div className="tool-head">
        <span className={stateClass}>{stateIcon}</span>
        <span className="tool-name">{message.name}</span>
        {argsPreview && <span className="tool-args-preview">{argsPreview}</span>}
        <span className="tool-expand">
          {expanded ? <ChevronDownIcon size={13} /> : <ChevronRightIcon size={13} />}
        </span>
      </div>
      {expanded && (
        <div className="tool-body">
          {message.args && (
            <details open>
              <summary>参数</summary>
              <pre className="tool-json">{message.args}</pre>
            </details>
          )}
          {message.result !== undefined && (
            <details open={message.state === 'error'}>
              <summary>结果{message.state === 'error' ? '（失败）' : ''}</summary>
              <pre className={`tool-result ${message.state === 'error' ? 'error' : ''}`}>{message.result}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
});

const MessageItem = memo(function MessageItem({ message }: { message: UiMessage }) {
  if (message.kind === 'user') {
    return (
      <div className="msg-row user">
        <div className="msg-bubble user">{message.text}</div>
        <span className="msg-time">{formatTime(new Date(message.ts).toISOString())}</span>
      </div>
    );
  }
  if (message.kind === 'assistant') {
    const BotIcon = appIcons.bot;
    return (
      <div className="msg-row assistant">
        <div className="msg-avatar">
          <BotIcon size={16} />
        </div>
        <div className="msg-content">
          <Markdown text={message.text} />
        </div>
      </div>
    );
  }
  if (message.kind === 'tool') return <ToolCard message={message} />;
  if (message.kind === 'thinking') {
    const SparklesIcon = appIcons.sparkles;
    return (
      <div className="thinking-block">
        <span className="thinking-icon">
          <SparklesIcon size={13} />
        </span>
        <span>{message.text}</span>
      </div>
    );
  }
  return <div className={`notice-block ${message.variant === 'error' ? 'error' : ''}`}>{message.text}</div>;
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
  onSend,
  onAbort,
  onOpenSidebar,
}: ConversationProps) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(0);

  // 终端在跑同一 session（快照 turnState === 'running'），与 daemon 远程运行区分开。
  const localRunning = session.turnState === 'running';
  const busy = running || localRunning;

  useEffect(() => {
    if (!running && !localRunning) inputRef.current?.focus();
  }, [running, localRunning]);

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
  const modelLabel = [snapshot.providerId, snapshot.model].filter(Boolean).join(' / ');
  const effortLabel = snapshot.effort && snapshot.effort !== 'none' ? snapshot.effort : undefined;
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
            </span>
          )}
          {!running && localRunning && (
            <span className="live-badge local">
              <span className="live-dot" />
              本机运行中
            </span>
          )}
        </div>
        <div className="conversation-meta">
          <span className="meta-item">{machine.name}</span>
          <span className="meta-item" title={session.cwd}>
            {session.cwd}
          </span>
          {modelLabel && <span className="meta-item">{modelLabel}</span>}
          {effortLabel && <span className="meta-item">effort {effortLabel}</span>}
          {snapshot.role && <span className="meta-item">role {snapshot.role}</span>}
          <span className={`conn-badge ${connected ? 'ok' : connecting ? 'connecting' : 'lost'}`}>
            {connected ? '实时连接' : connecting ? '连接中…' : '连接断开，自动重连中…'}
          </span>
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
        {localRunning && !running && (
          <div className="notice-block">该会话正在本机终端运行，请等待完成后再继续，避免并发冲突</div>
        )}
        <textarea
          ref={inputRef}
          value={draft}
          placeholder={running ? '远程任务运行中…' : localRunning ? '本机终端正在运行…' : '继续对话，Enter 发送，Shift+Enter 换行'}
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

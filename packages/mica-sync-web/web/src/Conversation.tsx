import { memo, useEffect, useRef, useState } from 'react';
import type { MachineInfo, StoredSession } from './api';
import { formatTime } from './format';
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
};

const ToolCard = memo(function ToolCard({ message }: { message: Extract<UiMessage, { kind: 'tool' }> }) {
  const [expanded, setExpanded] = useState(false);
  const stateIcon = message.state === 'running' ? '⏳' : message.state === 'done' ? '✓' : '✗';
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
        <span className="tool-expand">{expanded ? '▾' : '▸'}</span>
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
    return (
      <div className="msg-row assistant">
        <div className="msg-avatar">M</div>
        <div className="msg-content">
          <Markdown text={message.text} />
        </div>
      </div>
    );
  }
  if (message.kind === 'tool') return <ToolCard message={message} />;
  if (message.kind === 'thinking') {
    return (
      <div className="thinking-block">
        <span className="thinking-icon">💭</span>
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
}: ConversationProps) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 终端在跑同一 session（快照 turnState === 'running'），与 daemon 远程运行区分开。
  const localRunning = session.turnState === 'running';
  const busy = running || localRunning;

  useEffect(() => {
    if (!running && !localRunning) inputRef.current?.focus();
  }, [running, localRunning]);

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    onSend(text);
  };

  const snapshot = session.snapshot ?? {};
  const modelLabel = [snapshot.providerId, snapshot.model].filter(Boolean).join(' / ');
  const effortLabel = snapshot.effort && snapshot.effort !== 'none' ? snapshot.effort : undefined;

  return (
    <main className="conversation">
      <header className="conversation-header">
        <div className="conversation-title-row">
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

      <div className="messages-scroll">
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
              ■ 中止
            </button>
          ) : (
            <button className="send-button" onClick={send} disabled={!draft.trim() || busy}>
              发送
            </button>
          )}
        </div>
      </div>
    </main>
  );
});

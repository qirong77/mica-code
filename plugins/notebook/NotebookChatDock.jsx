import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  Clipboard,
  PanelLeftClose,
  Send,
  Sparkles,
  Square,
} from 'lucide-react';
import { Button } from '@mica-config-ui/web';

import { createNotebookChat } from './chat-controller';

function messageText(message, Markdown) {
  if (!message.text) return message.streaming ? '正在思考…' : '';
  return Markdown ? <Markdown text={message.text} streaming={message.streaming} /> : message.text;
}

/**
 * Notebook 侧边对话：每次展开都创建一条新的 Mica 会话，只消费宿主提供的
 * app-server 会话能力。这里不拼接笔记正文，也不加任何 system / user prompt；
 * textarea 的内容就是发给会话的内容。
 */
export function NotebookChatDock({ api, open = true, onClose }) {
  const sessionsApi = api?.sessions;
  const Markdown = api?.ui?.Markdown;
  const [state, setState] = useState({
    sessionId: '',
    messages: [],
    draft: '',
    running: false,
    loading: false,
    sending: false,
    stopping: false,
    error: '',
    status: '',
  });
  const { sessionId, messages, draft, running, stopping } = state;
  const [copyError, setCopyError] = useState('');
  const [copiedId, setCopiedId] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const [width, setWidth] = useState(null);
  const control = useRef(null);
  const mounted = useRef(false);
  const pinned = useRef(true);
  const log = useRef(null);
  const composer = useRef(null);
  const copyTimer = useRef(null);
  const resize = useRef(null);
  const panel = useRef(null);
  const opened = useRef(false);
  const conversationRequest = useRef(0);

  useEffect(() => {
    mounted.current = true;
    if (sessionsApi) {
      control.current = createNotebookChat({ sessions: sessionsApi, onChange: setState });
      setState(control.current.getState());
    }
    return () => {
      mounted.current = false;
      conversationRequest.current += 1;
      clearTimeout(copyTimer.current);
      control.current?.dispose();
      control.current = null;
    };
  }, [sessionsApi]);

  const scrollToBottom = useCallback((smooth = false) => {
    const node = log.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    setAtBottom(true);
  }, []);

  const startConversation = useCallback(async () => {
    const request = ++conversationRequest.current;
    if (!sessionsApi?.create || !control.current) {
      setState((current) => ({
        ...current,
        loading: false,
        error: '当前页面没有创建 Mica 会话的能力，请从桌面端打开笔记本。',
      }));
      return;
    }
    setState((current) => ({
      ...current,
      sessionId: '',
      messages: [],
      draft: '',
      loading: true,
      error: '',
      status: '正在准备新的 Mica 会话…',
    }));
    try {
      const created = await sessionsApi.create();
      if (request !== conversationRequest.current || !mounted.current) return;
      if (!created?.id) throw new Error('Mica 会话创建失败');
      await control.current.select(created.id, created.cwd);
    } catch (cause) {
      if (request === conversationRequest.current && mounted.current) {
        setState((current) => ({
          ...current,
          loading: false,
          error: cause?.message || String(cause),
          status: '',
        }));
      }
    }
  }, [sessionsApi]);

  useEffect(() => {
    if (!open) {
      opened.current = false;
      conversationRequest.current += 1;
      return;
    }
    if (!opened.current) {
      opened.current = true;
      void startConversation();
    } else {
      void control.current?.refresh();
    }
  }, [open, startConversation]);

  useEffect(() => {
    if (!open) return undefined;
    const restore = () => {
      if (document.visibilityState === 'visible') void control.current?.refresh();
    };
    window.addEventListener('mica:transport-resync', restore);
    document.addEventListener('visibilitychange', restore);
    return () => {
      window.removeEventListener('mica:transport-resync', restore);
      document.removeEventListener('visibilitychange', restore);
    };
  }, [open]);

  useEffect(() => {
    const node = log.current;
    if (!open || !node) return undefined;
    const observer = new ResizeObserver(() => {
      if (pinned.current) scrollToBottom();
    });
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    if (pinned.current) scrollToBottom();
    return () => observer.disconnect();
  }, [open, scrollToBottom]);

  useEffect(() => {
    if (open && pinned.current) scrollToBottom();
  }, [messages, open, scrollToBottom]);

  useEffect(() => {
    const node = composer.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(Math.max(node.scrollHeight, 70), 150)}px`;
  }, [draft, open]);

  const send = () => {
    pinned.current = true;
    setAtBottom(true);
    void control.current?.send();
  };

  const copyMessage = async (item) => {
    try {
      await navigator.clipboard.writeText(item.text);
      setCopiedId(item.id);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedId((current) => (current === item.id ? '' : current)), 1200);
    } catch (cause) {
      setCopyError(cause?.message || String(cause));
    }
  };

  if (!open) return null;
  return (
    <>
      <button type="button" className="notebook-chat-mask" tabIndex={-1} aria-label="收起对话浮层" onClick={onClose} />
      <aside
        ref={panel}
        className="notebook-chat"
        style={width ? { '--notebook-chat-width': `${width}px` } : undefined}
        aria-label="AI 对话"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && event.target.tagName !== 'TEXTAREA') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div
          className="notebook-chat-resize"
          role="separator"
          aria-label="调整对话宽度"
          aria-orientation="vertical"
          aria-valuemin={320}
          aria-valuemax={640}
          aria-valuenow={width || 380}
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            resize.current = { x: event.clientX, width: panel.current.getBoundingClientRect().width };
            event.currentTarget.setPointerCapture(event.pointerId);
            event.preventDefault();
          }}
          onPointerMove={(event) => {
            if (!resize.current) return;
            setWidth(Math.max(320, Math.min(640, resize.current.width + resize.current.x - event.clientX)));
          }}
          onPointerUp={(event) => {
            resize.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onLostPointerCapture={() => {
            resize.current = null;
          }}
          onDoubleClick={() => setWidth(null)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            setWidth(
              Math.max(
                320,
                Math.min(
                  640,
                  (width || panel.current.getBoundingClientRect().width) + (event.key === 'ArrowLeft' ? 24 : -24),
                ),
              ),
            );
          }}
        />
        <header className="notebook-chat-head">
          <div className="notebook-chat-heading">
            <span className="notebook-chat-heading-icon" aria-hidden="true">
              <Sparkles size={16} strokeWidth={1.7} />
            </span>
            <span className="notebook-chat-heading-copy">
              <strong>AI 对话</strong>
              <small>新的 Mica 会话</small>
            </span>
          </div>
          <Button
            variant="ghost"
            icon={<PanelLeftClose size={15} />}
            title="收起对话"
            aria-label="收起对话"
            onClick={onClose}
          />
        </header>
        <div className={`notebook-chat-session-strip ${running ? 'is-running' : ''}`}>
          <span>{running ? 'Mica 正在运行' : state.loading ? '正在准备会话' : sessionId ? '独立新会话' : '等待会话'}</span>
          <span className="notebook-chat-session-note">内容原样发送</span>
        </div>
        <div
          className="notebook-chat-log"
          ref={log}
          onScroll={() => {
            const node = log.current;
            if (!node) return;
            pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
            setAtBottom(pinned.current);
          }}
        >
          <div className="notebook-chat-messages">
            {!sessionsApi && <p className="notebook-chat-empty">这个宿主没有提供 Mica 会话能力。</p>}
            {sessionsApi && state.loading && !messages.length && (
              <div className="notebook-chat-welcome is-loading" aria-label="准备新的 Mica 会话">
                <span className="notebook-chat-welcome-icon"><Sparkles size={19} /></span>
                <strong>正在准备新的对话</strong>
                <span>会话会由 Mica 的进程运行。</span>
              </div>
            )}
            {sessionsApi && sessionId && !state.loading && !messages.length && !state.error && (
              <div className="notebook-chat-welcome">
                <span className="notebook-chat-welcome-icon"><Sparkles size={19} /></span>
                <strong>开始一段新对话</strong>
                <span>直接输入问题，Mica 会在独立会话中回答。</span>
              </div>
            )}
            {messages.map((item) => (
              <div key={item.id} className={`notebook-chat-message is-${item.role}`}>
                <div className="notebook-chat-message-meta">
                  {item.role === 'user' ? '你' : <><Sparkles size={11} /> Mica</>}
                </div>
                <div className="notebook-chat-text">
                  {messageText(item, item.role === 'assistant' ? Markdown : null)}
                </div>
                {item.text && (
                  <Button
                    variant="ghost"
                    size="compact"
                    className="notebook-chat-copy"
                    icon={copiedId === item.id ? <Check size={12} /> : <Clipboard size={12} />}
                    title="复制消息"
                    aria-label="复制消息"
                    onClick={() => void copyMessage(item)}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
        {!atBottom && (
          <Button
            variant="ghost"
            size="compact"
            className="notebook-chat-jump"
            onClick={() => {
              pinned.current = true;
              scrollToBottom(true);
            }}
          >
            回到底部
          </Button>
        )}
        {(state.error || copyError) && (
          <div className="notebook-chat-notice is-error" role="alert">
            <span>{state.error || copyError}</span>
            <Button
              variant="ghost"
              size="compact"
              onClick={() => {
                setCopyError('');
                void control.current?.refresh();
              }}
            >
              重试
            </Button>
          </div>
        )}
        {state.status &&
          state.status !== '正在回答…' &&
          state.status !== '正在发送…' &&
          state.status !== '正在读取…' &&
          state.status !== '正在准备新的 Mica 会话…' && (
            <div className="notebook-chat-notice" role="status">
              {state.status}
            </div>
          )}
        <div className="notebook-chat-compose">
          <textarea
            ref={composer}
            value={draft}
            placeholder={sessionId ? '输入消息…（Enter 发送，Shift+Enter 换行）' : '正在准备新的会话…'}
            aria-label="消息内容"
            disabled={!sessionId || !sessionsApi || state.loading}
            rows={3}
            onChange={(event) => control.current?.setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (!running && !state.loading) send();
              }
            }}
          />
          <div className="notebook-chat-actions">
            <span className={running ? 'is-running' : undefined}>
              {state.remoteRunning
                ? '其他窗口正在运行'
                : stopping
                  ? '正在停止…'
                  : running
                    ? 'Mica 正在回答'
                    : '消息会原样交给 Mica'}
            </span>
            <Button
              variant={running ? 'danger-ghost' : 'accent'}
              size="compact"
              icon={running ? <Square size={13} /> : <Send size={13} />}
              disabled={
                !sessionId ||
                state.loading ||
                state.remoteRunning ||
                (running ? stopping : !draft.trim() || state.sending)
              }
              onClick={() => (running ? void control.current?.stop() : send())}
            >
              {state.remoteRunning ? '外部运行' : stopping ? '停止中' : running ? '停止' : '发送'}
            </Button>
          </div>
        </div>
      </aside>
    </>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Clipboard,
  MessageSquare,
  PanelLeftClose,
  RefreshCw,
  Search,
  Send,
  Square,
} from 'lucide-react';
import { Button, Input, ArcoPopover, MenuList, MenuItem } from '@mica-config-ui/web';

import { createNotebookChat } from './chat-controller';

const CHAT_SESSION_KEY = 'mica.notebook.chat-session';

function readStoredSession() {
  try {
    return window.localStorage.getItem(CHAT_SESSION_KEY) || '';
  } catch {
    return '';
  }
}

function writeStoredSession(id) {
  try {
    if (id) window.localStorage.setItem(CHAT_SESSION_KEY, id);
    else window.localStorage.removeItem(CHAT_SESSION_KEY);
  } catch {
    // localStorage 只影响下次默认会话，不影响当前对话。
  }
}

function sessionPath(cwd) {
  if (!cwd) return '';
  const parts = String(cwd).split('/').filter(Boolean);
  return parts.slice(-2).join('/') || cwd;
}

function sessionTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const elapsed = Date.now() - date.getTime();
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 3_600_000) return `${Math.max(1, Math.floor(elapsed / 60_000))} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
}

function messageText(message, Markdown) {
  if (!message.text) return message.streaming ? '正在思考…' : '';
  return Markdown ? <Markdown text={message.text} streaming={message.streaming} /> : message.text;
}

/**
 * Notebook 侧边对话：只消费宿主提供的 app-server 会话能力。
 * 这里不拼接笔记正文，也不加任何 system / user prompt；textarea 的内容就是发给会话的内容。
 */
export function NotebookChatDock({ api, open = true, onClose }) {
  const sessionsApi = api?.sessions;
  const Markdown = api?.ui?.Markdown;
  const [sessions, setSessions] = useState([]);
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
  const [query, setQuery] = useState('');
  const [picker, setPicker] = useState(false);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [copyError, setCopyError] = useState('');
  const [copiedId, setCopiedId] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const [width, setWidth] = useState(null);
  const control = useRef(null);
  const savedSession = useRef(readStoredSession());
  const initialized = useRef(false);
  const mounted = useRef(false);
  const listRequest = useRef(0);
  const pinned = useRef(true);
  const log = useRef(null);
  const composer = useRef(null);
  const copyTimer = useRef(null);
  const resize = useRef(null);
  const panel = useRef(null);
  const opened = useRef(false);

  useEffect(() => {
    mounted.current = true;
    if (sessionsApi) {
      control.current = createNotebookChat({ sessions: sessionsApi, onChange: setState });
      setState(control.current.getState());
    }
    return () => {
      mounted.current = false;
      initialized.current = false;
      listRequest.current += 1;
      clearTimeout(copyTimer.current);
      control.current?.dispose();
      control.current = null;
    };
  }, [sessionsApi]);

  const active = sessions.find((item) => item.id === sessionId) || null;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((item) => `${item.title} ${item.cwd || ''}`.toLowerCase().includes(needle));
  }, [query, sessions]);

  const scrollToBottom = useCallback((smooth = false) => {
    const node = log.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    setAtBottom(true);
  }, []);

  const refresh = useCallback(async () => {
    if (!sessionsApi) return;
    const request = ++listRequest.current;
    setLoading(true);
    setListError('');
    try {
      // 搜索基于完整会话列表，不把第 81 条以后的会话藏掉。
      const rows = await sessionsApi.list({ limit: 10000 });
      if (request === listRequest.current && mounted.current) setSessions(Array.isArray(rows) ? rows : []);
    } catch (cause) {
      if (request === listRequest.current && mounted.current) setListError(cause?.message || String(cause));
    } finally {
      if (request === listRequest.current && mounted.current) setLoading(false);
    }
  }, [sessionsApi]);

  // 在笔记页里预热一次目录。打开面板用已有结果，不为一次点击先显示等待文字。
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!open || !control.current || initialized.current || !sessions.length) return;
    initialized.current = true;
    const id =
      savedSession.current && sessions.some((row) => row.id === savedSession.current)
        ? savedSession.current
        : sessions[0]?.id || '';
    if (id) {
      writeStoredSession(id);
      void control.current.select(id, sessions.find((row) => row.id === id)?.cwd);
    }
  }, [open, sessions]);

  useEffect(() => {
    if (!open) setPicker(false);
    else if (opened.current) void control.current?.refresh();
    if (open) opened.current = true;
  }, [open]);

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

  const choose = (id) => {
    pinned.current = true;
    setAtBottom(true);
    setCopyError('');
    if (id !== sessionId) void control.current?.select(id, sessions.find((row) => row.id === id)?.cwd);
    writeStoredSession(id);
    setPicker(false);
    setQuery('');
    composer.current?.focus();
  };

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
        aria-label="对话"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !picker && event.target.tagName !== 'TEXTAREA') {
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
          <ArcoPopover
            trigger="click"
            position="br"
            className="notebook-chat-picker-popover"
            escToClose
            popupVisible={picker}
            onVisibleChange={(visible) => {
              setPicker(visible);
              if (!visible) setQuery('');
            }}
            triggerProps={{ showArrow: false }}
            content={
              <div className="notebook-chat-picker-panel" role="dialog" aria-label="选择会话">
                <Input
                  autoFocus
                  prefix={<Search size={14} />}
                  value={query}
                  placeholder="搜索标题或目录"
                  aria-label="搜索标题或目录"
                  onChange={setQuery}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      event.currentTarget
                        .closest('[role="dialog"]')
                        ?.querySelector('[role="menuitemcheckbox"]')
                        ?.focus();
                    }
                  }}
                />
                <div className="notebook-chat-picker-summary">
                  <span>{query ? `${filtered.length} 条匹配` : `${sessions.length} 条会话`}</span>
                  <span>在原会话继续</span>
                </div>
                <MenuList className="notebook-chat-list" aria-label="Mica 会话" onClose={() => setPicker(false)}>
                  {loading && !sessions.length && (
                    <div className="notebook-chat-skeleton" aria-label="加载会话列表">
                      <i />
                      <i />
                    </div>
                  )}
                  {!loading && !filtered.length && (
                    <p className="notebook-chat-empty">{query ? '没有匹配的会话' : '还没有会话，请先在 Mica 创建'}</p>
                  )}
                  {filtered.slice(0, 100).map((item) => (
                    <MenuItem
                      key={item.id}
                      selected={item.id === sessionId}
                      className="notebook-chat-option"
                      onClick={() => choose(item.id)}
                    >
                      <span className="notebook-chat-option-copy" title={`${item.title}\n${item.cwd || item.id}`}>
                        <span className="notebook-chat-option-title">
                          <span>{item.title}</span>
                          {item.id === sessionId && <Check size={12} />}
                        </span>
                        <small>
                          <span>{sessionPath(item.cwd)}</span>
                          <span>{sessionTime(item.updatedAt)}</span>
                        </small>
                      </span>
                    </MenuItem>
                  ))}
                </MenuList>
                {filtered.length > 100 && <small>显示前 100 条，输入关键词可查找全部会话。</small>}
              </div>
            }
          >
            <span className="notebook-chat-picker-anchor">
              {' '}
              <Button
                variant="ghost"
                className="notebook-chat-picker-toggle mica-arco-row"
                title={active ? `${active.title}\n${active.cwd || sessionId}` : '选择会话'}
                aria-label="选择会话"
                aria-expanded={picker}
              >
                <MessageSquare size={14} />
                <span className="notebook-chat-picker-copy">
                  <span className="notebook-chat-title">
                    {active?.title || (sessionId ? '已选择会话' : '选择会话')}
                  </span>
                </span>
                <ChevronDown size={13} />
              </Button>
            </span>
          </ArcoPopover>
          <Button
            variant="ghost"
            icon={<RefreshCw size={14} />}
            title="刷新会话列表"
            aria-label="刷新会话列表"
            disabled={loading || !sessionsApi}
            onClick={() => void refresh()}
          />
          <Button
            variant="ghost"
            icon={<PanelLeftClose size={15} />}
            title="收起对话"
            aria-label="收起对话"
            onClick={onClose}
          />
        </header>
        <div className={`notebook-chat-session-strip ${running ? 'is-running' : ''}`}>
          <span>{running ? '正在运行' : state.loading ? '同步中' : sessionId ? '当前会话' : '未选择会话'}</span>
          {active?.cwd && (
            <span className="notebook-chat-cwd" title={active.cwd}>
              {sessionPath(active.cwd)}
            </span>
          )}
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
            {!sessionsApi && <p className="notebook-chat-empty">这个宿主没有提供 app-server 会话能力。</p>}
            {sessionsApi && !sessionId && <p className="notebook-chat-empty">先选择一条会话，然后就能在这里继续聊。</p>}
            {sessionsApi && sessionId && !state.loading && !messages.length && !state.error && (
              <p className="notebook-chat-empty">这条会话还没有对话。</p>
            )}
            {state.loading && !messages.length && (
              <div className="notebook-chat-skeleton" aria-label="加载对话记录">
                <i />
                <i />
                <i />
              </div>
            )}
            {messages.map((item) => (
              <div key={item.id} className={`notebook-chat-message is-${item.role}`}>
                <div className="notebook-chat-message-meta">{item.role === 'user' ? '你' : 'Mica'}</div>
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
        {(state.error || listError || copyError) && (
          <div className="notebook-chat-notice is-error" role="alert">
            <span>{state.error || listError || copyError}</span>
            <Button
              variant="ghost"
              size="compact"
              onClick={() => {
                setCopyError('');
                if (listError) void refresh();
                else void control.current?.refresh();
              }}
            >
              重试读取
            </Button>
          </div>
        )}
        {state.status &&
          state.status !== '正在回答…' &&
          state.status !== '正在发送…' &&
          state.status !== '正在读取…' && (
            <div className="notebook-chat-notice" role="status">
              {state.status}
            </div>
          )}
        <div className="notebook-chat-compose">
          <textarea
            ref={composer}
            value={draft}
            placeholder={sessionId ? '输入消息…（Enter 发送，Shift+Enter 换行）' : '先选择一条会话'}
            aria-label="消息内容"
            disabled={!sessionId || !sessionsApi}
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
                    : '内容原样发送，不会附加笔记'}
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

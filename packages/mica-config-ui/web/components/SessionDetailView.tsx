import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { readSessionContent, readSessionDetails, writeSession } from '../api.js';
import { useAutoSave } from '../useAutoSave.js';
import { ConversationPane } from './ConversationPane.js';
import { ContextPane } from './ContextPane.js';
import { JsonEditor } from './JsonEditor.js';
import { Button, Empty, SaveStatus, Tag } from './Ui.js';
import type { ConfigWebSessionDetails } from '../../src/shared/types.js';

export type SessionDetailTab = 'conversation' | 'context' | 'raw';

/** 宿主自带的页签（桌面端的用量 / 子代理）：内容由宿主渲染，这里只负责接入标签条。 */
export type SessionDetailExtraTab = {
  id: string;
  label: string;
  content: ReactNode;
};

const BASE_TABS: { id: SessionDetailTab; label: string }[] = [
  { id: 'conversation', label: '对话记录' },
  { id: 'context', label: 'Context 分析' },
  { id: 'raw', label: '原始文件' },
];

/**
 * 会话详情：一份快照的三个观察角度。
 *
 * 「对话记录」看模型实际收到/产出了什么，「Context 分析」看这些内容各自占了多大体积，
 * 「原始文件」看落盘的 JSON 本身。三个页签读同一个 sessionId 的不同投影，所以放在同一个
 * 组件里：桌面端的会话详情、上下文弹窗与配置页的 Sessions 页都用它，同一个会话在任何入口
 * 都不会长得不一样。
 */
export function SessionDetailView({
  sessionId,
  defaultTab = 'conversation',
  extraTabs = [],
  showHead = true,
}: {
  sessionId: string;
  defaultTab?: SessionDetailTab;
  extraTabs?: SessionDetailExtraTab[];
  showHead?: boolean;
}) {
  const [header, setHeader] = useState<ConfigWebSessionDetails | null>(null);
  const [tab, setTab] = useState<string>(defaultTab);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [rawContent, setRawContent] = useState('');
  const [rawSavedContent, setRawSavedContent] = useState('');
  const [rawLoaded, setRawLoaded] = useState(false);

  const lastUpdatedAtRef = useRef<string | null>(null);
  const rawRef = useRef({ rawContent, rawSavedContent, rawLoaded });
  rawRef.current = { rawContent, rawSavedContent, rawLoaded };

  const dirty = rawContent !== rawSavedContent;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const running = header?.turnState === 'running';

  // 半句 JSON 不写盘：本地先解析一遍，解析不过就只显示提示，等内容合法再落盘。
  const jsonError = useMemo(() => {
    if (!dirty) return null;
    try {
      JSON.parse(rawContent);
      return null;
    } catch (parseError) {
      return formatError(parseError);
    }
  }, [dirty, rawContent]);

  const autoSave = useAutoSave<{ id: string; content: string }, ConfigWebSessionDetails>({
    save: async ({ id, content }) => {
      await writeSession(id, content);
      return readSessionDetails(id);
    },
    onSaved: (next, saved) => {
      lastUpdatedAtRef.current = next.updatedAt;
      setHeader(next);
      setRawSavedContent(saved.content);
      setVersion((value) => value + 1);
    },
  });
  const { schedule } = autoSave;

  // turn 结束时补一次：运行中敲的内容被 editRawContent 直接跳过，没人再催它写盘。
  useEffect(() => {
    if (running) return;
    const latest = rawRef.current;
    if (!latest.rawLoaded) return;
    if (latest.rawContent === latest.rawSavedContent || jsonError) return;
    schedule({ id: sessionId, content: latest.rawContent });
  }, [running, jsonError, schedule, sessionId]);

  // 快照在磁盘上变了（本轮跑完、另一个进程写了它）就重载页签内容。
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    async function refresh(showLoading: boolean) {
      if (showLoading) setLoading(true);
      try {
        const next = await readSessionDetails(sessionId);
        if (cancelled) return;
        if (lastUpdatedAtRef.current !== null && lastUpdatedAtRef.current !== next.updatedAt) {
          setVersion((value) => value + 1);
        }
        lastUpdatedAtRef.current = next.updatedAt;
        setHeader(next);
        setError(null);
      } catch (loadError) {
        if (!cancelled) setError(formatError(loadError));
      } finally {
        if (!cancelled && showLoading) setLoading(false);
      }
    }
    void refresh(true);
    timer = window.setInterval(() => {
      // 正在编辑原始文件时不要用磁盘上的版本盖掉手上的改动。
      if (dirtyRef.current) return;
      void refresh(false);
    }, 2000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [sessionId]);

  /** 改动当场登记写盘：切页签/卸载不会丢掉已经开始的那一次保存。 */
  function editRawContent(next: string) {
    setRawContent(next);
    if (!rawLoaded || running) return;
    if (next === rawSavedContent) return;
    try {
      JSON.parse(next);
    } catch {
      return;
    }
    schedule({ id: sessionId, content: next });
  }

  async function openRawTab() {
    setTab('raw');
    if (rawLoaded) return;
    await reloadRaw();
  }

  async function reloadRaw() {
    try {
      const next = await readSessionContent(sessionId);
      setRawContent(next.content);
      setRawSavedContent(next.content);
      setRawLoaded(true);
    } catch (loadError) {
      setError(formatError(loadError));
    }
  }

  const tabs = [
    ...BASE_TABS.slice(0, 2).map((item) => ({ id: item.id as string, label: item.label })),
    ...extraTabs.map((item) => ({ id: item.id, label: item.label })),
    { id: 'raw' as string, label: BASE_TABS[2].label },
  ];

  if (loading && !header) return <div className="page-loading">正在加载 Session…</div>;
  if (!header) {
    return (
      <Empty description={error ?? '读不到这个会话：文件可能已被删除'} />
    );
  }

  return (
    <div className="session-detail">
      {showHead ? <SessionHead session={header} /> : null}
      <div className="session-tabs" role="tablist" aria-label="Session 视图">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`session-tab${tab === item.id ? ' session-tab-active' : ''}`}
            onClick={() => {
              if (item.id === 'raw') void openRawTab();
              else setTab(item.id);
            }}
          >
            {item.label}
            {item.id === 'raw' && dirty ? <span className="session-tab-dirty">●</span> : null}
          </button>
        ))}
        <span className="session-tabs-tail">
          {tab === 'raw' ? (
            <>
              <SaveStatus saving={autoSave.saving} saved={autoSave.status === 'saved'} />
              {running ? <span className="muted-text">运行中，暂停写盘</span> : null}
              {jsonError && !running ? <Tag tone="red">JSON 未写完</Tag> : null}
              {dirty && !jsonError && !running ? <Tag tone="blue">待写入</Tag> : null}
            </>
          ) : null}
        </span>
      </div>

      {error ? <div className="ui-alert session-detail-alert">{error}</div> : null}

      <div className={`session-tab-body${tab === 'raw' ? ' session-tab-body-fill' : ''}`}>
        {tab === 'conversation' ? (
          <ConversationPane key={`conversation:${sessionId}:${version}`} sessionId={sessionId} refreshToken={version} />
        ) : null}
        {tab === 'context' ? (
          <ContextPane key={`context:${sessionId}:${version}`} sessionId={sessionId} refreshToken={version} />
        ) : null}
        {extraTabs.map((item) =>
          tab === item.id ? <div key={item.id}>{item.content}</div> : null,
        )}
        {tab === 'raw' ? (
          <div className="session-raw">
            <div className="session-raw-toolbar">
              <span className="muted-text">会话快照 JSON · 改动会写回磁盘</span>
              <Button
                title={dirty ? '先撤回改动再重新读取' : '重新从磁盘读取'}
                disabled={dirty || running}
                onClick={() => void reloadRaw()}
              >
                重新读取
              </Button>
            </div>
            <div className="editor-host session-raw-editor">
              <JsonEditor
                value={rawContent}
                language="json"
                readOnly={running}
                onChange={editRawContent}
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 详情头部：标题 + 身份行 + 一行事实。摘要不再单独占一张卡，避免它比正文还抢眼。 */
function SessionHead({ session }: { session: ConfigWebSessionDetails }) {
  const status = presentStatus(session.turnState);
  return (
    <header className="session-detail-head">
      <div className="session-detail-title">
        <h2 title={session.title}>{session.title}</h2>
        <Tag tone={status.tone} dot>
          {status.label}
        </Tag>
      </div>
      <p className="session-detail-path" title={session.cwd}>
        {shortenDir(session.cwd)}
      </p>
      <dl className="session-detail-facts">
        <MetaFact label="模型" value={`${session.providerId} · ${session.model}`} />
        <MetaFact label="角色" value={session.role} />
        <MetaFact label="更新" value={formatDate(session.updatedAt)} />
        <MetaFact
          label="文件"
          value={`${formatBytes(session.fileSizeBytes)} · ${session.messageCount} 条消息 · ${session.usageCount} 条用量`}
        />
      </dl>
    </header>
  );
}

function MetaFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="session-detail-fact">
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  );
}

function shortenDir(cwd: string): string {
  const parts = cwd.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 4) return cwd;
  return `…/${parts.slice(-4).join('/')}`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function presentStatus(turnState: string): { tone: 'default' | 'green' | 'red' | 'blue'; label: string } {
  switch (turnState) {
    case 'running':
      return { tone: 'blue', label: '运行中' };
    case 'completed':
      return { tone: 'green', label: '已完成' };
    case 'aborted':
      return { tone: 'default', label: '已中止' };
    case 'error':
      return { tone: 'red', label: '错误' };
    default:
      return { tone: 'default', label: turnState || '未知' };
  }
}

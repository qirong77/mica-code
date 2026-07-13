import { useEffect, useState } from 'react';
import { readConversationDetails } from '../api.js';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, Empty, Tag } from '../components/Ui.js';
import { appIcons } from '../icons.js';
import type {
  ConfigWebConversationDetails,
  ConfigWebConversationItem,
  ConfigWebConversationItemType,
} from '../../../src/shared/types.js';

export function ConversationPage({ refreshSignal = 0 }: { refreshSignal?: number }) {
  const [details, setDetails] = useState<ConfigWebConversationDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const RefreshIcon = appIcons.refresh;

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setDetails(await readConversationDetails());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [refreshSignal]);

  const toolCallCount = details?.items.filter((item) => item.type === 'tool_call').length ?? 0;
  const turnCount = details?.items.filter((item) => item.type === 'user').length ?? 0;

  return (
    <PageFrame
      title="Conversation"
      path={details ? `${details.providerId} · ${details.model} · ${details.protocol}` : undefined}
      actions={<Button icon={<RefreshIcon size={15} />} title="重新加载" onClick={load} loading={loading} />}
    >
      {error ? <Alert message={error} /> : null}
      {!details ? (
        <Empty description="暂无对话快照，请在终端中重新执行 /config" />
      ) : (
        <div className="conversation-layout">
          <div className="conversation-overview simple-card">
            <div>
              <span>Items</span>
              <strong>{details.items.length}</strong>
            </div>
            <div>
              <span>User turns</span>
              <strong>{turnCount}</strong>
            </div>
            <div>
              <span>Tool calls</span>
              <strong>{toolCallCount}</strong>
            </div>
            <div>
              <span>Updated</span>
              <strong>{formatDate(details.updatedAt)}</strong>
            </div>
          </div>

          <div className="conversation-timeline">
            {details.items.map((item) => (
              <ConversationItemCard key={`${item.sequence}-${item.type}-${item.callId ?? ''}`} item={item} />
            ))}
          </div>
        </div>
      )}
    </PageFrame>
  );
}

function ConversationItemCard({ item }: { item: ConfigWebConversationItem }) {
  const label = itemLabel(item);
  const metadata = [item.toolName, item.callId].filter(Boolean).join(' · ');
  const preview = contentPreview(item.content);
  const ChevronIcon = appIcons.chevronRight;

  return (
    <article className={`conversation-item conversation-item-${item.type}`}>
      <div className="conversation-sequence" aria-label={`第 ${item.sequence} 项`}>
        {item.sequence}
      </div>
      <details className="conversation-card simple-card">
        <summary className="conversation-card-header">
          <div className="conversation-card-title">
            <Tag tone={itemTone(item.type)}>{label}</Tag>
            {metadata ? <span className="conversation-card-meta">{metadata}</span> : null}
            <span className="conversation-card-preview">{preview}</span>
          </div>
          <span className="conversation-card-trailing">
            <span className="conversation-kind">{item.type.replace('_', ' ')}</span>
            <ChevronIcon className="conversation-chevron" size={15} aria-hidden="true" />
          </span>
        </summary>
        <pre className="conversation-content">{item.content || '(empty)'}</pre>
      </details>
    </article>
  );
}

function itemLabel(item: ConfigWebConversationItem): string {
  if (item.type === 'assistant') return 'LLM';
  if (item.type === 'tool_call') return 'Tool call';
  if (item.type === 'tool_result') return 'Tool result';
  if (item.type === 'unknown') return item.role || 'Unknown';
  return item.type.charAt(0).toUpperCase() + item.type.slice(1);
}

function itemTone(type: ConfigWebConversationItemType): 'default' | 'green' | 'red' | 'blue' {
  if (type === 'user') return 'blue';
  if (type === 'assistant') return 'green';
  if (type === 'unknown') return 'red';
  return 'default';
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

function contentPreview(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  return normalized || '(empty)';
}

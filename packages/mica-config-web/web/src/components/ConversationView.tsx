import { useState } from 'react';
import { Tag } from './Ui.js';
import { appIcons } from '../icons.js';
import type {
  ConfigWebConversationDetails,
  ConfigWebConversationItem,
  ConfigWebConversationItemType,
} from '../../../src/shared/types.js';

export function ConversationView({ details }: { details: ConfigWebConversationDetails }) {
  const toolCallCount = details.items.filter((item) => item.type === 'tool_call').length;
  const turnCount = details.items.filter((item) => item.type === 'user').length;

  return (
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
  );
}

function ConversationItemCard({ item }: { item: ConfigWebConversationItem }) {
  const metadata = [item.toolName, item.callId].filter(Boolean).join(' · ');
  const preview = contentPreview(item.content);
  const [expanded, setExpanded] = useState(false);
  const ChevronIcon = appIcons.chevronRight;

  return (
    <article className={`conversation-item conversation-item-${item.type}`}>
      <div className="conversation-sequence" aria-label={`第 ${item.sequence} 项`}>
        {item.sequence}
      </div>
      <details className="conversation-card simple-card" onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary className="conversation-card-header">
          <div className="conversation-card-title">
            <Tag tone={itemTone(item.type)}>{itemLabel(item)}</Tag>
            <div className="conversation-card-summary">
              {metadata ? (
                <span className="conversation-card-meta" title={metadata}>
                  {metadata}
                </span>
              ) : null}
              <span className="conversation-card-preview" title={preview}>
                {preview}
              </span>
            </div>
          </div>
          <span className="conversation-card-trailing">
            <ChevronIcon className="conversation-chevron" size={15} aria-hidden="true" />
          </span>
        </summary>
        {expanded ? <pre className="conversation-content">{item.content || '(empty)'}</pre> : null}
      </details>
    </article>
  );
}

function itemLabel(item: ConfigWebConversationItem): string {
  if (item.type === 'assistant') return 'LLM';
  if (item.type === 'tool_call') return 'Tool call';
  if (item.type === 'tool_result') return 'Tool result';
  if (item.type === 'unknown') return item.role || 'Other';
  return item.type.charAt(0).toUpperCase() + item.type.slice(1);
}

function itemTone(type: ConfigWebConversationItemType): 'default' | 'green' | 'red' | 'blue' {
  if (type === 'user') return 'blue';
  if (type === 'assistant') return 'green';
  return 'default';
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

function contentPreview(content: string): string {
  const sample = content.slice(0, 2_000);
  const normalized = sample.replace(/\s+/g, ' ').trim();
  if (!normalized) return '(empty)';
  return normalized.length > 240 || sample.length < content.length ? `${normalized.slice(0, 240)}…` : normalized;
}

import { useMemo } from 'react';
import type {
  ConfigWebConversationDetails,
  ConfigWebConversationItem,
} from '../../../src/shared/types.js';

type ChatBlock =
  | { kind: 'user'; key: string; content: string }
  | {
      kind: 'assistant';
      key: string;
      thinking?: string;
      tools: ChatToolStep[];
      answer?: string;
    }
  | { kind: 'system'; key: string; content: string }
  | { kind: 'unknown'; key: string; content: string; role?: string };

type ChatToolStep = {
  key: string;
  name: string;
  callId?: string;
  args: string;
  result?: string;
  status: 'done' | 'error' | 'pending';
};

export function ChatTranscript({
  details,
  pending = false,
}: {
  details: ConfigWebConversationDetails;
  pending?: boolean;
}) {
  const blocks = useMemo(() => groupConversationItems(details.items), [details.items]);

  return (
    <div className="chat-transcript">
      {blocks.map((block) => {
        if (block.kind === 'user') {
          return (
            <div key={block.key} className="chat-turn chat-turn-user">
              <div className="chat-user-bubble">{block.content || '(empty)'}</div>
            </div>
          );
        }

        if (block.kind === 'assistant') {
          return (
            <div key={block.key} className="chat-turn chat-turn-assistant">
              {block.thinking ? <ThinkingBlock content={block.thinking} /> : null}
              {block.tools.length > 0 ? (
                <div className="chat-tool-list">
                  {block.tools.map((tool) => (
                    <ToolStep key={tool.key} step={tool} />
                  ))}
                </div>
              ) : null}
              {block.answer ? <div className="chat-assistant-text">{block.answer}</div> : null}
              {!block.thinking && block.tools.length === 0 && !block.answer ? (
                <div className="chat-assistant-text chat-assistant-muted">(empty)</div>
              ) : null}
            </div>
          );
        }

        if (block.kind === 'system') {
          return (
            <details key={block.key} className="chat-system-block">
              <summary>System prompt</summary>
              <pre>{block.content || '(empty)'}</pre>
            </details>
          );
        }

        return (
          <div key={block.key} className="chat-turn chat-turn-unknown">
            <div className="chat-assistant-meta">{block.role || 'other'}</div>
            <pre className="chat-unknown-content">{block.content || '(empty)'}</pre>
          </div>
        );
      })}

      {pending ? (
        <div className="chat-turn chat-turn-assistant">
          <div className="chat-pending-line">正在生成回复…</div>
        </div>
      ) : null}
    </div>
  );
}

function ThinkingBlock({ content }: { content: string }) {
  return (
    <details className="chat-thinking">
      <summary>思考过程</summary>
      <pre>{content}</pre>
    </details>
  );
}

function ToolStep({ step }: { step: ChatToolStep }) {
  const summary = toolSummary(step);
  const mark = step.status === 'error' ? '✗' : step.status === 'pending' ? '◌' : '✓';
  const hasBody = Boolean(step.args.trim() || step.result?.trim());

  if (!hasBody) {
    return (
      <div className={`chat-tool-step chat-tool-${step.status}`}>
        <span className="chat-tool-mark" aria-hidden="true">
          {mark}
        </span>
        <span className="chat-tool-summary">{summary}</span>
      </div>
    );
  }

  return (
    <details className={`chat-tool-step chat-tool-${step.status}`}>
      <summary>
        <span className="chat-tool-mark" aria-hidden="true">
          {mark}
        </span>
        <span className="chat-tool-summary">{summary}</span>
      </summary>
      <div className="chat-tool-body">
        {step.args.trim() ? (
          <section>
            <header>输入</header>
            <pre>{step.args}</pre>
          </section>
        ) : null}
        {step.result?.trim() ? (
          <section>
            <header>输出</header>
            <pre>{step.result}</pre>
          </section>
        ) : null}
      </div>
    </details>
  );
}

export function groupConversationItems(items: ConfigWebConversationItem[]): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  let index = 0;

  while (index < items.length) {
    const item = items[index]!;

    if (item.type === 'system') {
      // System prompt is not part of the chat transcript UI.
      index += 1;
      continue;
    }

    if (item.type === 'user') {
      blocks.push({
        kind: 'user',
        key: `user-${item.sequence}`,
        content: item.content,
      });
      index += 1;
      continue;
    }

    if (item.type === 'assistant' || item.type === 'tool_call' || item.type === 'tool_result') {
      const start = item.sequence;
      let thinking: string | undefined;
      let answer: string | undefined;
      const tools: ChatToolStep[] = [];
      const pendingById = new Map<string, ChatToolStep>();

      while (index < items.length) {
        const current = items[index]!;
        if (current.type === 'user' || current.type === 'system' || current.type === 'unknown') break;

        if (current.type === 'assistant') {
          // Prefer last non-empty assistant text in the segment as final answer.
          if (current.content.trim()) answer = current.content;
          index += 1;
          continue;
        }

        if (current.type === 'tool_call') {
          const step: ChatToolStep = {
            key: `tool-${current.sequence}-${current.callId ?? current.toolName ?? 'call'}`,
            name: current.toolName || 'tool',
            callId: current.callId,
            args: current.content || '',
            status: 'pending',
          };
          tools.push(step);
          if (current.callId) pendingById.set(current.callId, step);
          index += 1;
          continue;
        }

        if (current.type === 'tool_result') {
          const matched = current.callId ? pendingById.get(current.callId) : undefined;
          if (matched) {
            matched.result = current.content;
            matched.status = looksLikeError(current.content) ? 'error' : 'done';
          } else {
            tools.push({
              key: `tool-result-${current.sequence}`,
              name: current.toolName || 'tool',
              callId: current.callId,
              args: '',
              result: current.content,
              status: looksLikeError(current.content) ? 'error' : 'done',
            });
          }
          index += 1;
          continue;
        }

        index += 1;
      }

      // Heuristic: if assistant text looks like pure reasoning dump and tools exist, keep as thinking.
      // Current backend usually does not emit thinking; keep field for future.
      if (!thinking && answer && tools.length > 0 && looksLikeThinkingOnly(answer)) {
        thinking = answer;
        answer = undefined;
      }

      blocks.push({
        kind: 'assistant',
        key: `assistant-${start}`,
        thinking,
        tools: tools.map((tool) =>
          tool.status === 'pending' && tool.result === undefined
            ? { ...tool, status: 'done' } // historical sessions: no live pending
            : tool,
        ),
        answer,
      });
      continue;
    }

    blocks.push({
      kind: 'unknown',
      key: `unknown-${item.sequence}`,
      content: item.content,
      role: item.role,
    });
    index += 1;
  }

  return blocks;
}

function toolSummary(step: ChatToolStep): string {
  const goal = extractToolGoal(step.name, step.args);
  if (goal) return `${step.name} · ${goal}`;
  return step.name;
}

function extractToolGoal(name: string, argsText: string): string {
  const raw = argsText.trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const preferredKeys = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'skill', 'description', 'prompt'];
    for (const key of preferredKeys) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) return truncate(value.trim(), 72);
    }
    if (typeof parsed.operation === 'string') return truncate(parsed.operation, 72);
  } catch {
    // fall through
  }
  return truncate(raw.replace(/\s+/g, ' '), 72);
}

function looksLikeError(content: string): boolean {
  const sample = content.slice(0, 200).toLowerCase();
  return (
    sample.startsWith('error:') ||
    sample.includes('\nerror:') ||
    sample.includes('trace') && sample.includes('error') ||
    sample.includes('failed') && sample.includes('error')
  );
}

function looksLikeThinkingOnly(content: string): boolean {
  const sample = content.trim();
  if (sample.length < 40) return false;
  // very conservative: only when it is explicitly tagged
  return sample.startsWith('<thinking>') || sample.startsWith('Thinking:') || sample.startsWith('思考：');
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

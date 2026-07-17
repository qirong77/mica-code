import { memo, useState, type ReactNode } from 'react';
import type {
  ConfigWebConversationDetails,
  ConfigWebConversationItem,
} from '../../../src/shared/types.js';

type TextStep = {
  kind: 'text';
  key: string;
  content: string;
};

export type ToolStep = {
  kind: 'tool';
  key: string;
  call: ConfigWebConversationItem;
  result?: ConfigWebConversationItem;
  running?: boolean;
  legacy?: boolean;
};

export type ChatBlock =
  | { kind: 'user'; key: string; content: string }
  | { kind: 'assistant'; key: string; steps: Array<TextStep | ToolStep> };

export type TerminalLiveItem =
  | { type: 'text'; key: string; content: string }
  | { type: 'tool'; key: string; callId: string; toolName: string; arguments: string; result?: string; running: boolean };

export type TerminalLiveTurn = {
  items: TerminalLiveItem[];
  thinkingChars: number;
};

type ChatTranscriptProps = {
  details: ConfigWebConversationDetails;
  pendingUser?: string;
  liveTurn?: TerminalLiveTurn | null;
};

export const ChatTranscript = memo(function ChatTranscript({
  details,
  pendingUser,
  liveTurn,
}: ChatTranscriptProps) {
  const hasStaticContent = details.items.some((item) => item.type !== 'system' && item.content.trim());
  if (!hasStaticContent && !pendingUser) {
    return (
      <div className="terminal-empty">
        <div className="terminal-empty-mark">mica</div>
        <p>Start a conversation with Mica.</p>
        <span>Enter 发送 · Shift + Enter 换行</span>
      </div>
    );
  }

  return (
    <div className="terminal-transcript">
      <StaticTranscript details={details} />
      {pendingUser ? <UserTurn content={pendingUser} pending /> : null}
      {liveTurn ? <LiveAssistantTurn turn={liveTurn} /> : null}
    </div>
  );
});

const StaticTranscript = memo(function StaticTranscript({ details }: { details: ConfigWebConversationDetails }) {
  const blocks = groupConversationItems(details.items);
  return blocks.map((block) =>
    block.kind === 'user' ? (
      <UserTurn key={block.key} content={block.content} />
    ) : (
      <AssistantTurn key={block.key} steps={block.steps} />
    ),
  );
});

function UserTurn({ content, pending = false }: { content: string; pending?: boolean }) {
  return (
    <article className={`terminal-turn terminal-user-turn${pending ? ' terminal-turn-pending' : ''}`}>
      <span className="terminal-gutter terminal-user-gutter" aria-hidden="true" />
      <div className="terminal-user-content">{content}</div>
    </article>
  );
}

function AssistantTurn({ steps }: { steps: Array<TextStep | ToolStep> }) {
  return (
    <article className="terminal-turn terminal-assistant-turn">
      <span className="terminal-assistant-marker" aria-hidden="true">●</span>
      <div className="terminal-assistant-content">
        {steps.map((step) =>
          step.kind === 'text' ? (
            <MarkdownText key={step.key} content={step.content} />
          ) : (
            <TerminalToolStep key={step.key} step={step} />
          ),
        )}
      </div>
    </article>
  );
}

function LiveAssistantTurn({ turn }: { turn: TerminalLiveTurn }) {
  return (
    <article className="terminal-turn terminal-assistant-turn terminal-live-turn" aria-live="polite">
      <span className="terminal-assistant-marker terminal-pulse" aria-hidden="true">●</span>
      <div className="terminal-assistant-content">
        {turn.items.length === 0 ? <span className="terminal-waiting">waiting for model…</span> : null}
        {turn.items.map((item) => {
          if (item.type === 'text') return <MarkdownText key={item.key} content={item.content} />;
          const call: ConfigWebConversationItem = {
            sequence: 1,
            type: 'tool_call',
            content: item.arguments,
            callId: item.callId,
            toolName: item.toolName,
          };
          const result: ConfigWebConversationItem | undefined = item.result === undefined
            ? undefined
            : {
                sequence: 2,
                type: 'tool_result',
                content: item.result,
                callId: item.callId,
                toolName: item.toolName,
              };
          return (
            <TerminalToolStep
              key={item.key}
              step={{ kind: 'tool', key: item.key, call, result, running: item.running }}
            />
          );
        })}
      </div>
    </article>
  );
}

function TerminalToolStep({ step }: { step: ToolStep }) {
  const [expanded, setExpanded] = useState(false);
  const toolName = step.call.toolName ?? 'tool';
  const summary = formatToolSummary(toolName, step.call.content);
  const icon = getToolIcon(toolName);

  return (
    <details
      className={`terminal-tool${step.running ? ' terminal-tool-running' : ''}`}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span className="terminal-tool-icon" aria-hidden="true">{step.running ? '⋮' : icon}</span>
        <span className="terminal-tool-summary">{summary}</span>
        {step.legacy ? <span className="terminal-tool-note">legacy · not executed</span> : null}
      </summary>
      {expanded ? (
        <div className="terminal-tool-detail">
          <ToolPayload label="input" value={formatPayload(step.call.content)} />
          {step.result ? <ToolPayload label="output" value={step.result.content} /> : null}
          {step.running ? <div className="terminal-tool-progress">running…</div> : null}
        </div>
      ) : null}
    </details>
  );
}

function ToolPayload({ label, value }: { label: string; value: string }) {
  return (
    <section className="terminal-tool-payload">
      <span>{label}</span>
      <pre>{value || '—'}</pre>
    </section>
  );
}

export function groupConversationItems(items: ConfigWebConversationItem[]): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  const calls = new Map<string, ToolStep>();
  let currentAssistant: Extract<ChatBlock, { kind: 'assistant' }> | null = null;

  const ensureAssistant = (sequence: number) => {
    if (!currentAssistant) {
      currentAssistant = { kind: 'assistant', key: `assistant-${sequence}`, steps: [] };
      blocks.push(currentAssistant);
    }
    return currentAssistant;
  };

  for (const item of items) {
    if (item.type === 'system') continue;

    if (item.type === 'user') {
      blocks.push({ kind: 'user', key: `user-${item.sequence}`, content: item.content });
      currentAssistant = null;
      continue;
    }

    if (item.type === 'assistant') {
      const assistant = ensureAssistant(item.sequence);
      const fragments = splitLegacyToolMarkup(item);
      for (const [index, fragment] of fragments.entries()) {
        if (fragment.kind === 'text') {
          if (fragment.content.trim()) {
            assistant.steps.push({ kind: 'text', key: `text-${item.sequence}-${index}`, content: fragment.content });
          }
        } else {
          assistant.steps.push(fragment.step);
          if (fragment.step.call.callId) calls.set(fragment.step.call.callId, fragment.step);
        }
      }
      continue;
    }

    if (item.type === 'tool_call') {
      const step: ToolStep = { kind: 'tool', key: `tool-${item.callId ?? item.sequence}`, call: item };
      ensureAssistant(item.sequence).steps.push(step);
      if (item.callId) calls.set(item.callId, step);
      continue;
    }

    if (item.type === 'tool_result') {
      const step = item.callId ? calls.get(item.callId) : undefined;
      if (step) {
        step.result = item;
      } else {
        ensureAssistant(item.sequence).steps.push({
          kind: 'tool',
          key: `result-${item.callId ?? item.sequence}`,
          call: {
            ...item,
            type: 'tool_call',
            content: '',
            toolName: item.toolName ?? 'tool',
          },
          result: item,
        });
      }
      continue;
    }

    if (item.content.trim()) {
      ensureAssistant(item.sequence).steps.push({
        kind: 'text',
        key: `unknown-${item.sequence}`,
        content: item.content,
      });
    }
  }

  return blocks.filter((block) => block.kind === 'user' || block.steps.length > 0);
}

type LegacyFragment =
  | { kind: 'text'; content: string }
  | { kind: 'tool'; step: ToolStep };

function splitLegacyToolMarkup(item: ConfigWebConversationItem): LegacyFragment[] {
  const fragments: LegacyFragment[] = [];
  const pattern = /<use_tool>\s*<tool_name>([\s\S]*?)<\/tool_name>([\s\S]*?)<\/use_tool>/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(item.content))) {
    if (match.index > cursor) fragments.push({ kind: 'text', content: item.content.slice(cursor, match.index) });
    const toolName = decodeXmlText(match[1] ?? '').trim() || 'tool';
    const args = parseLegacyToolArgs(match[2] ?? '');
    const callId = `legacy-${item.sequence}-${index++}`;
    fragments.push({
      kind: 'tool',
      step: {
        kind: 'tool',
        key: callId,
        legacy: true,
        call: {
          sequence: item.sequence,
          type: 'tool_call',
          content: JSON.stringify(args),
          callId,
          toolName,
        },
      },
    });
    cursor = match.index + match[0].length;
  }

  if (cursor < item.content.length) fragments.push({ kind: 'text', content: item.content.slice(cursor) });
  return fragments.length > 0 ? fragments : [{ kind: 'text', content: item.content }];
}

function parseLegacyToolArgs(source: string): Record<string, string> {
  const args: Record<string, string> = {};
  const pattern = /<([a-zA-Z_][\w-]*)>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) args[match[1]!] = decodeXmlText(match[2] ?? '').trim();
  return args;
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

export function formatToolSummary(toolName: string, rawArgs: string): string {
  const args = parseArguments(rawArgs);
  const readString = (...keys: string[]) => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === 'string' && value.trim()) return oneLine(value);
    }
    return '';
  };

  if (toolName === 'run_shell') return `$ ${truncate(readString('command') || 'run shell', 220)}`;
  if (toolName === 'read_file') {
    const path = readString('file_path', 'path') || 'file';
    const offset = typeof args.offset === 'number' ? `:${args.offset}` : '';
    const limit = typeof args.limit === 'number' ? ` +${args.limit} lines` : '';
    return `read ${path}${offset}${limit}`;
  }
  if (toolName === 'read_image') return `view ${readString('source') || 'image'}`;
  if (toolName === 'write_file') return `write ${readString('file_path', 'path') || 'file'}`;
  if (toolName === 'list_files') {
    const path = readString('path') || '.';
    const pattern = readString('pattern');
    return `list ${path}${pattern ? ` · ${pattern}` : ''}`;
  }
  if (toolName === 'grep_search') {
    const pattern = readString('pattern') || 'text';
    return `grep ${JSON.stringify(truncate(pattern, 90))} in ${readString('path') || '.'}`;
  }
  if (toolName === 'web_search') return `search web · ${truncate(readString('query') || 'query', 180)}`;
  if (toolName === 'web_fetch') return `fetch ${truncate(readString('url') || 'url', 180)}`;
  if (toolName === 'apply_patch') return 'apply patch';
  if (toolName === 'Skill') return `skill ${readString('skill') || ''}`.trim();
  if (toolName === 'Agent') return `agent ${readString('subagent_type') || ''} · ${readString('description')}`.trim();

  const firstValue = Object.values(args).find((value) => typeof value === 'string');
  return `${toolName}${firstValue ? ` · ${truncate(oneLine(firstValue), 160)}` : ''}`;
}

function getToolIcon(name: string): string {
  if (name.startsWith('mcp__')) return '🔌';
  return {
    read_file: '📖',
    read_image: '📷',
    write_file: '✍️',
    list_files: '📂',
    grep_search: '🔎',
    run_shell: '⚡',
    web_fetch: '🔗',
    web_search: '🌐',
    Skill: '✨',
    apply_patch: '🩹',
    Agent: '🤖',
  }[name] ?? '⚙';
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function formatPayload(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function MarkdownText({ content }: { content: string }) {
  const lines = content.split('\n');
  const nodes: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').startsWith('```')) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      index += 1;
      nodes.push(
        <div className="terminal-code" key={`code-${index}`}>
          {language ? <span>{language}</span> : null}
          <pre>{code.join('\n')}</pre>
        </div>,
      );
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      nodes.push(
        <div className={`terminal-heading terminal-heading-${heading[1]!.length}`} key={`heading-${index}`}>
          {inlineMarkdown(heading[2]!, `heading-${index}`)}
        </div>,
      );
      index += 1;
      continue;
    }

    const list = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (list) {
      nodes.push(
        <div className="terminal-list-line" key={`list-${index}`}>
          <span>{list[1]}</span>
          <div>{inlineMarkdown(list[2]!, `list-${index}`)}</div>
        </div>,
      );
      index += 1;
      continue;
    }

    if (!line.trim()) {
      nodes.push(<div className="terminal-paragraph-gap" key={`gap-${index}`} />);
      index += 1;
      continue;
    }

    nodes.push(<div className="terminal-text-line" key={`line-${index}`}>{inlineMarkdown(line, `line-${index}`)}</div>);
    index += 1;
  }

  return <div className="terminal-markdown">{nodes}</div>;
}

function inlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      nodes.push(<code key={`${keyPrefix}-${match.index}`}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={`${keyPrefix}-${match.index}`}>{token.slice(2, -2)}</strong>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      nodes.push(
        <a key={`${keyPrefix}-${match.index}`} href={link?.[2]} target="_blank" rel="noreferrer">
          {link?.[1]}
        </a>,
      );
    }
    cursor = match.index + token.length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

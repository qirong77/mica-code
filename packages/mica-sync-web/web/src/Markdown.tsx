import { Fragment, type ReactNode } from 'react';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  parts.forEach((part, index) => {
    if (!part) return;
    if (part.startsWith('`') && part.endsWith('`')) {
      nodes.push(
        <code key={`${keyPrefix}-${index}`} className="inline-code">
          {part.slice(1, -1)}
        </code>,
      );
    } else if (part.startsWith('**') && part.endsWith('**')) {
      nodes.push(
        <strong key={`${keyPrefix}-${index}`} className="inline-strong">
          {part.slice(2, -2)}
        </strong>,
      );
    } else {
      nodes.push(<Fragment key={`${keyPrefix}-${index}`}>{escapeHtml(part)}</Fragment>);
    }
  });
  return nodes;
}

/** Minimal markdown renderer: code fences, inline code, bold, paragraphs. */
export function Markdown({ text }: { text: string }) {
  const blocks = text.split(/(```[\s\S]*?```)/g);
  const rendered: ReactNode[] = [];
  let paragraph = 0;
  let blockIndex = 0;

  blocks.forEach((block) => {
    const fence = /^```(\w*)\n?([\s\S]*?)```$/.exec(block);
    if (fence) {
      rendered.push(
        <pre key={`pre-${blockIndex++}`} className="code-block">
          <code>{escapeHtml(fence[2] ?? '')}</code>
        </pre>,
      );
      paragraph = 0;
      return;
    }
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        paragraph = 0;
        continue;
      }
      if (/^[-*] /.test(trimmed)) {
        rendered.push(
          <div key={`li-${blockIndex++}`} className="list-item">
            <span className="list-bullet">•</span>
            <span>{renderInline(trimmed.slice(2), `li-${blockIndex}`)}</span>
          </div>,
        );
        paragraph = 0;
        continue;
      }
      if (paragraph === 0) {
        rendered.push(<p key={`p-${blockIndex++}`}>{renderInline(line, `p-${blockIndex}`)}</p>);
        paragraph = 1;
      } else {
        rendered.push(<p key={`p-${blockIndex++}`}>{renderInline(line, `p-${blockIndex}`)}</p>);
      }
    }
  });

  return <div className="markdown">{rendered}</div>;
}

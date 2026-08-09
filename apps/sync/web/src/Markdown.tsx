import { memo } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

function CodeBlock({ children }: ComponentProps<'pre'>) {
  return <pre className="chat-code-block">{children}</pre>;
}

const components: Components = {
  pre: CodeBlock,
  table: ({ children }: { children?: ReactNode }) => (
    <div className="chat-table-wrap">
      <table>{children}</table>
    </div>
  ),
  input: (props) => <input {...props} disabled />,
};

/**
 * Markdown renderer shared with mica-code-app: react-markdown + GFM, wrapped in
 * the same `.chat-markdown` container so the two UIs render identically.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {text || ''}
      </ReactMarkdown>
    </div>
  );
});

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@anthropic/ink', () => ({
  Box: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, undefined, children),
  Text: ({ bold, children }: { bold?: boolean; children?: React.ReactNode }) =>
    bold
      ? React.createElement('strong', undefined, children)
      : React.createElement(React.Fragment, undefined, children),
}));

const { PromptFrame } = await import('./PromptFrame.js');

describe('PromptFrame', () => {
  it('keeps the default role marker unchanged', () => {
    const html = renderToStaticMarkup(
      React.createElement(PromptFrame, { mode: 'default', role: 'default', children: 'input' }),
    );

    expect(html).toBe('<strong>❯</strong>input');
  });

  it('shows a non-default role before the input marker', () => {
    const html = renderToStaticMarkup(
      React.createElement(PromptFrame, { mode: 'default', role: 'chat', children: 'input' }),
    );

    expect(html).toBe('chat <strong>❯</strong>input');
  });
});

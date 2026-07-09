import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@anthropic/ink', () => ({
  Ansi: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Box: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Text: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useInput: vi.fn(),
  useDeclaredCursor: vi.fn(() => null),
  useTerminalFocus: vi.fn(() => true),
  stringWidth: (value: string) => value.length,
  wrapAnsi: (value: string) => value,
}));

const { SimpleTextInput } = await import('./CursorInput.js');

describe('SimpleTextInput', () => {
  it('renders dim suggestion suffix for quick command completion', () => {
    const html = renderToStaticMarkup(
      <SimpleTextInput
        value="/ta"
        suggestion="/task "
        onChange={() => {}}
        columns={80}
        cursorOffset={3}
        onChangeCursorOffset={() => {}}
      />,
    );

    expect(html).toContain('/ta');
    expect(html).toContain('sk ');
  });

  it('does not render suggestion suffix when suggestion does not extend value', () => {
    const html = renderToStaticMarkup(
      <SimpleTextInput
        value="/task"
        suggestion="/other"
        onChange={() => {}}
        columns={80}
        cursorOffset={5}
        onChangeCursorOffset={() => {}}
      />,
    );

    expect(html).not.toContain('/other');
  });

  it('does not render suggestion suffix before three typed characters', () => {
    const html = renderToStaticMarkup(
      <SimpleTextInput
        value="/t"
        suggestion="/task "
        onChange={() => {}}
        columns={80}
        cursorOffset={2}
        onChangeCursorOffset={() => {}}
      />,
    );

    expect(html).not.toContain('ask ');
  });
});

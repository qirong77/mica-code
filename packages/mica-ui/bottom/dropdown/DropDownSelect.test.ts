import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic/ink', () => ({
  Box: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  useStdin: () => ({ internal_querier: null }),
  useTerminalSize: () => ({ columns: 80, rows: 24 }),
}));

vi.mock('../../hooks/index.js', () => ({
  useScheduleState: () => ({
    visible: true,
    items: [{ key: 'help', label: '/help' }],
    selectedIndex: 0,
  }),
}));

vi.mock('../../hooks/useLogViewHeight.js', () => ({
  useBottomPanelHeight: () => 18,
}));

vi.mock('./CommandDropdown.js', () => ({
  CommandDropdown: ({ height }: { height?: number }) =>
    React.createElement('div', { 'data-testid': 'command-dropdown', 'data-height': height }),
}));

const { DropDownSelect, resolveDropdownHeight } = await import('./DropDownSelect.js');

describe('DropDownSelect', () => {
  it('uses a conservative height before the physical cursor row is known', () => {
    const html = renderToStaticMarkup(React.createElement(DropDownSelect));

    expect(html).toContain('data-testid="command-dropdown"');
    expect(html).toContain('data-height="8"');
  });

  it('fills the visible rows below the physical input cursor without overflowing the terminal', () => {
    expect(resolveDropdownHeight(24, 18, 6)).toBe(15);
  });
});

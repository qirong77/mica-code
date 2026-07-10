import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic/ink', () => ({
  useTerminalSize: () => ({ columns: 80, rows: 24 }),
}));

vi.mock('@packages/@anthropic/ink/src/hooks/use-stdin.js', () => ({
  default: () => ({ internal_querier: null }),
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

  it.each([
    { rows: 24, fallbackHeight: 18, cursorRow: null, expected: 8 },
    { rows: 24, fallbackHeight: 4, cursorRow: null, expected: 4 },
    { rows: 2, fallbackHeight: 5, cursorRow: null, expected: 1 },
    { rows: 24, fallbackHeight: 18, cursorRow: 6, expected: 15 },
    { rows: 24, fallbackHeight: 18, cursorRow: 23, expected: 1 },
  ])('resolves a safe height from $rows rows and cursor row $cursorRow', (testCase) => {
    expect(resolveDropdownHeight(testCase.rows, testCase.fallbackHeight, testCase.cursorRow)).toBe(testCase.expected);
  });
});

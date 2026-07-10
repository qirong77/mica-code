import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic/ink', () => ({
  Box: ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children),
}));

vi.mock('../../hooks/index.js', () => ({
  useScheduleState: () => ({
    visible: true,
    items: [{ key: 'help', label: '/help' }],
    selectedIndex: 0,
  }),
}));

vi.mock('../../hooks/useLogViewHeight.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useLogViewHeight.js')>()),
  useBottomPanelHeight: () => 18,
}));

vi.mock('./CommandDropdown.js', () => ({
  CommandDropdown: ({ height }: { height?: number }) =>
    React.createElement('div', { 'data-testid': 'command-dropdown', 'data-height': height }),
}));

const { DropDownSelect } = await import('./DropDownSelect.js');

describe('DropDownSelect', () => {
  it('uses the shared bottom panel height', () => {
    const html = renderToStaticMarkup(React.createElement(DropDownSelect));

    expect(html).toContain('data-testid="command-dropdown"');
    expect(html).toContain('data-height="18"');
  });
});

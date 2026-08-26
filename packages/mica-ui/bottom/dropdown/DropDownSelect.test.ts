import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../hooks/index.js', () => ({
  useScheduleState: () => ({
    visible: true,
    kind: 'file',
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

const { DropDownSelect } = await import('./DropDownSelect.js');

describe('DropDownSelect', () => {
  it('lets file search size its list to the number of results and show from the top', () => {
    const html = renderToStaticMarkup(React.createElement(DropDownSelect));

    expect(html).toContain('data-testid="command-dropdown"');
    expect(html).toContain('data-height="1"');
  });
});

import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogHost, dialogStore } from './components/DialogHost.js';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));
vi.mock('./components/Modal.js', () => ({
  Modal: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));

afterEach(() => dialogStore.settle(false));

function buttons() {
  const html = renderToStaticMarkup(createElement(DialogHost));
  return [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]);
}

describe('dialog action hierarchy', () => {
  it('renders ordinary confirm as an accent primary action and cancel as secondary', () => {
    void dialogStore.confirm({ title: 'Continue?' });
    const [cancel, confirm] = buttons();
    expect(cancel).toContain('arco-btn-secondary');
    expect(confirm).toContain('arco-btn-primary');
    expect(confirm).not.toContain('arco-btn-status-danger');
  });

  it('retains danger styling and the safe default focus for destructive confirms', () => {
    void dialogStore.confirm({ title: 'Delete?', danger: true });
    const [cancel, confirm] = buttons();
    expect(cancel).toContain('autofocus');
    expect(confirm).toContain('arco-btn-status-danger');
    expect(confirm).not.toContain('autofocus');
  });

  it.each(['', 'Project'])('uses an accent prompt action with initial value %j', (initialValue) => {
    void dialogStore.prompt({ title: 'Name', initialValue });
    const [cancel, confirm] = buttons();
    expect(cancel).toContain('arco-btn-secondary');
    expect(confirm).toContain('arco-btn-primary');
    expect(confirm.includes('disabled=""')).toBe(initialValue === '');
    const html = renderToStaticMarkup(createElement(DialogHost));
    expect(html).toMatch(/<input\b[^>]*autofocus/);
  });
});

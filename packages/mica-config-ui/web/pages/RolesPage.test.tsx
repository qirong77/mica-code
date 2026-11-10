import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { ConfigWebRolesDetails } from '../../src/shared/types.js';
import { ROLE_LABELS } from '../labels.js';
import { RolesPage } from './RolesPage.js';

const state = vi.hoisted(() => ({ values: [] as unknown[], schedule: vi.fn(), setState: vi.fn() }));

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: () => [state.values.shift(), state.setState],
  useMemo: (factory: () => unknown) => factory(),
  useEffect: () => undefined,
}));
vi.mock('../useAutoSave.js', () => ({
  useAutoSave: () => ({ schedule: state.schedule, flush: vi.fn() }),
}));
vi.mock('../components/DialogHost.js', () => ({ confirmDialog: vi.fn(), promptDialog: vi.fn() }));
vi.mock('../components/PageFrame.js', () => ({
  PageFrame: ({ description, actions, children }: { description: string; actions: ReactNode; children: ReactNode }) => (
    <main>
      <p>{description}</p>
      {actions}
      {children}
    </main>
  ),
}));
vi.mock('../components/Ui.js', () => ({
  Alert: ({ message }: { message: string }) => <p>{message}</p>,
  Button: ({
    children,
    onClick,
    disabled,
    title,
  }: {
    children: ReactNode;
    onClick: () => void;
    disabled?: boolean;
    title?: string;
  }) => (
    <button onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  ),
  Empty: () => null,
  SaveStatus: () => null,
  Tag: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock('../components/JsonEditor.js', () => ({
  JsonEditor: ({ value, readOnly }: { value: string; readOnly: boolean }) => (
    <textarea value={value} readOnly={readOnly} onChange={() => undefined} />
  ),
}));

const details: ConfigWebRolesDetails = {
  root: '/isolated/role',
  roles: [
    { name: 'default', content: 'Common rules.', builtIn: true },
    { name: 'reviewer', content: 'Review carefully.', builtIn: false },
  ],
};

function page(name: string) {
  state.values = [details, name, details.roles.find((role) => role.name === name)!.content, false, false, null, null];
  return RolesPage();
}

function elements(node: ReactNode, matches: (element: ReactElement) => boolean): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap((child) => elements(child, matches));
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [...(matches(element) ? [element] : []), ...elements(element.props.children, matches)];
}

beforeEach(() => {
  state.schedule.mockReset();
  state.setState.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

function editorIn(root: ReactNode) {
  return elements(
    root,
    (node) => typeof node.props === 'object' && node.props !== null && 'language' in node.props,
  )[0]!;
}

describe('Roles page prompt layers', () => {
  it('keeps default visible and read-only, with an explicit copy action and no delete action', () => {
    const root = page('default');
    const html = renderToStaticMarkup(root);
    expect(html).toContain('默认系统提示词');
    expect(html).toContain('default');
    expect(html).toContain(ROLE_LABELS.defaultDescription);
    expect(html).toContain(ROLE_LABELS.copy);
    expect(html).not.toContain('删除');
    const editor = editorIn(root);
    expect((editor.props as { readOnly: boolean }).readOnly).toBe(true);
    (editor.props as { onChange: (value: string) => void }).onChange('Override');
    expect(state.schedule).not.toHaveBeenCalled();
    expect(state.setState).not.toHaveBeenCalled();
  });

  it('edits only the custom append body and explains its system-prompt position', () => {
    const root = page('reviewer');
    const html = renderToStaticMarkup(root);
    expect(html).toContain(ROLE_LABELS.appendedPrompt);
    expect(html).toContain('Review carefully.');
    expect(html).not.toContain('Common rules.');
    expect(html).toContain('删除');
    const editor = editorIn(root);
    expect((editor.props as { readOnly: boolean }).readOnly).toBe(false);
    (editor.props as { onChange: (value: string) => void }).onChange('New role body.');
    expect(state.schedule).toHaveBeenCalledWith({ name: 'reviewer', content: 'New role body.' });
  });

  it('copies the default body without altering it or scheduling a save', async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText: copy } });
    const root = page('default');
    const button = elements(root, (node) => (node.props as { children?: unknown }).children === ROLE_LABELS.copy)[0]!;
    await (button.props as { onClick: () => void }).onClick();
    expect(copy).toHaveBeenCalledWith('Common rules.');
    expect(state.schedule).not.toHaveBeenCalled();
  });
});

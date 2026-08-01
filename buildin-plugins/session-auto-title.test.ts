import { describe, expect, it, vi } from 'vitest';
import { HookRegistry } from '@packages/mica-plugin/HookRegistry.js';
import setupSessionAutoTitle, { normalizeGeneratedTitle, sessionAutoTitleLimits } from './session-auto-title.mjs';

describe('session auto title plugin', () => {
  it('generates a title after the first completed turn', async () => {
    const query = vi.fn(async (_input: string, _options?: unknown) => 'Fix mobile login flow');
    const sessionController = {
      getCurrentTitle: vi.fn(() => null as string | null),
      getCurrentSessionId: vi.fn(() => 'session-1'),
      hasManualTitle: vi.fn(() => false),
      renameCurrent: vi.fn((title: string) => {
        sessionController.getCurrentTitle.mockReturnValue(title);
      }),
      tryAutoRename: vi.fn((sessionId: string, title: string) => {
        if (sessionId !== 'session-1' || sessionController.hasManualTitle()) return false;
        sessionController.renameCurrent(title);
        return true;
      }),
    };
    const agent = {
      toConversationMessages: () => [
        { role: 'user', content: 'The login button is broken on mobile.' },
        { role: 'assistant', content: 'I will inspect it.' },
      ],
      createSubAgent: vi.fn(() => ({ query })),
    };
    const session = { agent, sessionController, titleOverride: null, updatedAt: '' };
    const hooks = new HookRegistry();
    const disposers: Array<() => void | Promise<void>> = [];
    const onTitleChanged = vi.fn();
    setupSessionAutoTitle(
      {
        pluginId: 'test.auto-title',
        hooks,
        logger: { warn: vi.fn() },
        onDispose: (dispose: () => void | Promise<void>) => disposers.push(dispose),
      },
      { findByAgent: (owner: unknown) => (owner === agent ? session : undefined) },
      onTitleChanged,
    );

    await hooks.emit('turn:after', { owner: agent, hasError: false });
    await vi.waitFor(() => expect(sessionController.renameCurrent).toHaveBeenCalledWith('Fix mobile login flow'));
    expect(query).toHaveBeenCalledWith('The login button is broken on mobile.', expect.objectContaining({ maxTurns: 1 }));
    expect(query.mock.calls[0]?.[0]).not.toContain('I will inspect it.');
    expect(agent.createSubAgent).toHaveBeenCalledWith(expect.objectContaining({ effort: 'none', tools: false }));
    expect(session.titleOverride).toBe('Fix mobile login flow');
    expect(onTitleChanged).toHaveBeenCalledOnce();
    await Promise.all(disposers.map((dispose) => dispose()));
  });

  it('does not run when there is no real user message', async () => {
    const agent = {
      toConversationMessages: () => [
        { role: 'assistant', content: 'Sure.' },
        { role: 'notice', content: 'Nothing user-initiated.' },
      ],
      createSubAgent: vi.fn(),
    };
    const hooks = new HookRegistry();
    setupSessionAutoTitle(
      {
        pluginId: 'test.auto-title',
        hooks,
        logger: { warn: vi.fn() },
        onDispose: vi.fn(),
      },
      {
        findByAgent: () => ({
          agent,
          sessionController: {
            getCurrentTitle: () => null,
            getCurrentSessionId: () => 'session-1',
            hasManualTitle: () => false,
          },
        }),
      },
    );

    await hooks.emit('turn:after', { owner: agent, hasError: false });
    expect(agent.createSubAgent).not.toHaveBeenCalled();
    expect(sessionAutoTitleLimits).toMatchObject({ minUserMessages: 1, minUserTextChars: 1 });
  });

  it('does not overwrite a manual rename that happens while generation is running', async () => {
    let finish!: (title: string) => void;
    const query = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)));
    let currentTitle: string | null = null;
    const sessionController = {
      getCurrentTitle: () => currentTitle,
      getCurrentSessionId: () => 'session-1',
      hasManualTitle: () => currentTitle !== null,
      renameCurrent: vi.fn(),
      tryAutoRename: vi.fn((sessionId: string, title: string) => {
        if (sessionId !== 'session-1' || currentTitle !== null) return false;
        sessionController.renameCurrent(title);
        return true;
      }),
    };
    const agent = {
      toConversationMessages: () => [
        { role: 'user', content: 'Investigate the failing authentication integration.' },
        { role: 'assistant', content: 'Checking.' },
        { role: 'user', content: 'Focus on token refresh behavior.' },
        { role: 'assistant', content: 'Understood.' },
        { role: 'user', content: 'Also cover the retry path in tests.' },
      ],
      createSubAgent: () => ({ query }),
    };
    const hooks = new HookRegistry();
    setupSessionAutoTitle(
      { pluginId: 'test.auto-title', hooks, logger: { warn: vi.fn() }, onDispose: vi.fn() },
      { findByAgent: () => ({ agent, sessionController, titleOverride: null, updatedAt: '' }) },
    );

    await hooks.emit('turn:after', { owner: agent, hasError: false });
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    currentTitle = 'My manual title';
    finish('Generated title');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessionController.renameCurrent).not.toHaveBeenCalled();
  });

  it('normalizes plain and JSON title responses', () => {
    expect(normalizeGeneratedTitle('  "Fix login retries"\nExplanation  ')).toBe('Fix login retries');
    expect(normalizeGeneratedTitle('{"title":"Improve session naming"}')).toBe('Improve session naming');
  });
});

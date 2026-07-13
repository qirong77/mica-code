import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfigWebWorkerCommand, updateConfigWebConversation } from './startConfigWeb.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveConfigWebWorkerCommand', () => {
  it('spawns Bun with the source entry in dev mode', () => {
    expect(
      resolveConfigWebWorkerCommand(['/opt/homebrew/bin/bun', '/repo/src/index.ts'], '/opt/homebrew/bin/bun'),
    ).toEqual({
      executable: '/opt/homebrew/bin/bun',
      entryArgs: ['/repo/src/index.ts'],
    });
  });

  it('spawns the compiled binary without Bun virtual entry args', () => {
    expect(resolveConfigWebWorkerCommand(['bun', '/$bunfs/root/mica'], '/Users/me/.local/bin/mica')).toEqual({
      executable: '/Users/me/.local/bin/mica',
      entryArgs: [],
    });
  });

  it('passes user args through when they are real entry args', () => {
    expect(
      resolveConfigWebWorkerCommand(
        ['/Users/me/bin/custom-runner', '/repo/src/index.ts', '--flag'],
        '/Users/me/bin/custom-runner',
      ),
    ).toEqual({
      executable: '/Users/me/bin/custom-runner',
      entryArgs: ['/repo/src/index.ts'],
    });
  });

  it('pushes conversation details to the token-protected local endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const conversation = {
      providerId: 'openai',
      protocol: 'openai_chat_completions' as const,
      model: 'gpt-5',
      updatedAt: '2026-01-02T03:04:05.000Z',
      items: [{ sequence: 1, type: 'system' as const, content: 'system prompt' }],
    };

    await updateConfigWebConversation(39127, 'secret token', conversation);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:39127/api/details/conversation?token=secret%20token',
      expect.objectContaining({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(conversation),
      }),
    );
  });

  it('reports a rejected conversation update', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Invalid conversation payload' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(
      updateConfigWebConversation(39127, 'token', {
        providerId: 'openai',
        protocol: 'openai_chat_completions',
        model: 'gpt-5',
        updatedAt: '2026-01-02T03:04:05.000Z',
        items: [],
      }),
    ).rejects.toThrow('Invalid conversation payload');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { PluginActionRegistry } from './PluginActions.js';

function registry(declared: Record<string, string[]> = {}) {
  return new PluginActionRegistry((pluginId) => declared[pluginId] ?? []);
}

describe('PluginActionRegistry', () => {
  it('runs the handler registered for the declared key', async () => {
    const actions = registry({ demo: ['register'] });
    const handler = vi.fn(async () => ({ message: '已注册', link: 'https://relay.example/?t=abc' }));
    actions.add('demo', 'register', handler);

    await expect(actions.run('demo', 'register', { values: { relayUrl: 'https://relay.example' } })).resolves.toEqual({
      message: '已注册',
      link: 'https://relay.example/?t=abc',
    });
    expect(handler).toHaveBeenCalledWith({ values: { relayUrl: 'https://relay.example' } });
  });

  // 没声明的 key 在页面上根本没有按钮，静默接受注册只会让插件以为用户点得到它
  it('refuses a key the manifest never declared', () => {
    const actions = registry({ demo: ['register'] });
    expect(() => actions.add('demo', 'delete-everything', async () => {})).toThrow(/没有声明动作 delete-everything/);
  });

  it('refuses the same key twice instead of silently replacing it', () => {
    const actions = registry({ demo: ['register'] });
    actions.add('demo', 'register', async () => {});
    expect(() => actions.add('demo', 'register', async () => {})).toThrow(/重复注册/);
  });

  it('keeps plugins apart even when they use the same key', async () => {
    const actions = registry({ a: ['register'], b: ['register'] });
    actions.add('a', 'register', async () => ({ message: 'a' }));
    actions.add('b', 'register', async () => ({ message: 'b' }));

    await expect(actions.run('a', 'register', { values: {} })).resolves.toEqual({ message: 'a' });
    await expect(actions.run('b', 'register', { values: {} })).resolves.toEqual({ message: 'b' });
  });

  it('drops the handler when the returned disposable is disposed', async () => {
    const actions = registry({ demo: ['register'] });
    const registration = actions.add('demo', 'register', async () => ({ message: 'ok' }));
    expect(actions.has('demo', 'register')).toBe(true);

    registration.dispose();

    expect(actions.has('demo', 'register')).toBe(false);
    await expect(actions.run('demo', 'register', { values: {} })).rejects.toThrow(/没有可执行的动作/);
  });

  it('reports why an action cannot run instead of doing nothing', async () => {
    const actions = registry();
    await expect(actions.run('demo', 'register', { values: {} })).rejects.toThrow(/没注册/);
  });
});

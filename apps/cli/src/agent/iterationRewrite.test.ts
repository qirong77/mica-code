import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime } from './AgentRuntime.js';
import { applyIterationRewrites, clearIterationRewrites, configureIterationRewrite, registerIterationRewrite } from './iterationRewrite.js';
import { estimateContextTokens } from '@packages/mica-context/tokenEstimate.js';

function runtime() {
  const getSnapshot = vi.fn(() => { throw new Error('A budget check must not copy the entire snapshot'); });
  const setPluginState = vi.fn();
  const estimateRequestOverheadTokens = vi.fn(() => 1400);
  const agent = {
    config: { model: 'test', provider: { contextWindowSize: 32000 } },
    getSnapshot, setPluginState, estimateRequestOverheadTokens,
    getPluginState: () => undefined, getLastUsage: () => undefined,
  } as unknown as AgentRuntime;
  return { agent, getSnapshot, setPluginState, estimateRequestOverheadTokens };
}

afterEach(() => {
  clearIterationRewrites();
  configureIterationRewrite({ mode: 'session', resolveSessionId: () => null, onError: () => {} });
});

describe('request history rewrite hosting', () => {
  it('binds the originating owner and reuses request overhead without materializing a snapshot', async () => {
    const host = runtime();
    const controller = new AbortController();
    const messages = [{ role: 'user', content: 'hello' }];
    registerIterationRewrite('probe', (history, handle) => {
      expect(handle.owner).toBe(host.agent);
      expect(handle.signal).toBe(controller.signal);
      expect(handle.contextWindowSize).toBe(32000);
      expect(handle.estimateTokens(history)).toBe(1400 + estimateContextTokens(messages));
      handle.estimateTokens(history);
      handle.setState({ runs: 1 });
      return null;
    });
    await applyIterationRewrites(messages, host.agent, controller.signal);
    expect(host.getSnapshot).not.toHaveBeenCalled();
    expect(host.estimateRequestOverheadTokens).toHaveBeenCalledTimes(1);
    expect(host.setPluginState).toHaveBeenCalledWith('probe', { runs: 1 });
  });

  it('returns promptly on stop even if an extension ignores cancellation, and discards late state', async () => {
    const host = runtime();
    const controller = new AbortController();
    let finish!: () => void;
    registerIterationRewrite('slow', async (messages, handle) => {
      await new Promise<void>(resolve => { finish = resolve; });
      handle.setState({ late: true });
      return [...messages, { role: 'user', content: 'late result' }];
    });
    const result = applyIterationRewrites([], host.agent, controller.signal);
    controller.abort();
    await expect(result).resolves.toBeNull();
    finish();
    await Promise.resolve();
    expect(host.setPluginState).not.toHaveBeenCalled();
  });

  it('isolates a failed error reporter and keeps later extensions running', async () => {
    const host = runtime();
    configureIterationRewrite({ onError: () => { throw new Error('disk full'); } });
    registerIterationRewrite('bad', () => { throw new Error('broken extension'); });
    registerIterationRewrite('good', messages => [...messages, { role: 'user', content: 'kept' }]);
    await expect(applyIterationRewrites([], host.agent)).resolves.toEqual([{ role: 'user', content: 'kept' }]);
  });

  it('does not invoke an extension disposed while an earlier extension is waiting', async () => {
    const host = runtime();
    let finish!: () => void;
    registerIterationRewrite('slow', async () => { await new Promise<void>(resolve => { finish = resolve; }); return null; });
    const disposedHandler = vi.fn(() => null);
    const registration = registerIterationRewrite('disposed', disposedHandler);
    const result = applyIterationRewrites([], host.agent);
    registration.dispose();
    finish();
    await result;
    expect(disposedHandler).not.toHaveBeenCalled();
  });
});

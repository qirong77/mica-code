import { describe, expect, it } from 'vitest';
import { HookRegistry } from './HookRegistry.js';

describe('HookRegistry.pipelineSync', () => {
  it('pipes synchronous hook results in priority order', () => {
    const hooks = new HookRegistry();
    hooks.on('system-prompt:build', (event: { prompt: string }) => ({
      event: { prompt: `${event.prompt} second` },
    }), { priority: 10 });
    hooks.on('system-prompt:build', (event: { prompt: string }) => ({
      event: { prompt: `${event.prompt} first` },
    }), { priority: 0 });

    expect(hooks.pipelineSync('system-prompt:build', { prompt: 'base' })).toEqual({
      prompt: 'base first second',
    });
  });

  it('rejects asynchronous handlers', () => {
    const hooks = new HookRegistry();
    hooks.on('system-prompt:build', async (event: { prompt: string }) => event);

    expect(() => hooks.pipelineSync('system-prompt:build', { prompt: 'base' })).toThrow(
      'Hook system-prompt:build must be synchronous',
    );
  });

  it('consumes rejections from handlers incorrectly registered as asynchronous', async () => {
    const hooks = new HookRegistry();
    hooks.on('system-prompt:build', async () => {
      throw new Error('async failure');
    });

    expect(() => hooks.pipelineSync('system-prompt:build', { prompt: 'base' })).toThrow('must be synchronous');
    await Promise.resolve();
  });
});

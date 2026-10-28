import { describe, expect, it } from 'vitest';
import { HookRegistry } from './HookRegistry.js';

describe('HookRegistry.notify', () => {
  it('reports failures and continues despite stop/block policies or hanging handlers', async () => {
    const hooks = new HookRegistry();
    const seen: string[] = [];
    const errors: string[] = [];
    hooks.setHandlerErrorReporter((error) => {
      errors.push((error as Error).message);
    });
    hooks.on(
      'observe',
      () => {
        throw new Error('sync');
      },
      { failPolicy: 'stop', priority: -2 },
    );
    hooks.on(
      'observe',
      async () => {
        throw new Error('async');
      },
      { failPolicy: 'block', priority: -1 },
    );
    hooks.on('observe', () => {
      seen.push('hang');
      return new Promise(() => {});
    });
    hooks.on('observe', () => {
      seen.push('last');
    });
    expect(hooks.notify('observe', {})).toBeUndefined();
    expect(seen).toEqual(['hang', 'last']);
    await Promise.resolve();
    expect(errors).toEqual(['sync', 'async']);
  });
});

describe('HookRegistry.pipelineSync', () => {
  it('pipes synchronous hook results in priority order', () => {
    const hooks = new HookRegistry();
    hooks.on(
      'system-prompt:build',
      (event: { prompt: string }) => ({
        event: { prompt: `${event.prompt} second` },
      }),
      { priority: 10 },
    );
    hooks.on(
      'system-prompt:build',
      (event: { prompt: string }) => ({
        event: { prompt: `${event.prompt} first` },
      }),
      { priority: 0 },
    );

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

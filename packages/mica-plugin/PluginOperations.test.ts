import { beforeEach, describe, expect, it } from 'vitest';
import { snapshot } from '@packages/mica-diagnostics/index.js';
import { operationResult, startPluginOperation } from '@packages/mica-diagnostics/operation.js';
import { observePluginHandler, observePluginTool } from './PluginOperations.js';
import { PluginManager } from './PluginManager.js';
import { HookRegistry } from './HookRegistry.js';
import { ServiceContainer } from './ServiceContainer.js';
import { micaCommands } from '@packages/mica-commands/index.js';
import { micaRuntime } from '@packages/mica-runtime/index.js';
import { PluginPanelRegistry } from './PluginPanel.js';
import { parsePluginManifest } from './PluginManifest.js';
import type { PluginContext } from './PluginContext.js';

let first = 0;
beforeEach(() => { first = snapshot(1000).length; });
const events = () => snapshot(1000).slice(first).filter((row) => row.scope === 'plugin-operation');
const context = { plugin: 'sample', pluginVersion: '1.0.0', operation: 'sample.run' };

describe('plugin operation contract', () => {
  it('distinguishes neutral outcomes from failures without reading content', () => {
    for (const outcome of ['cancelled', 'declined', 'waiting', 'conflict', 'busy', 'partial', 'unknown', 'skipped'])
      expect(operationResult({ outcome, ok: false, error: 'not a failure' }).outcome).toBe(outcome);
    expect(operationResult({ ok: false })).toEqual({ outcome: 'error', code: 'returned_error' });
    expect(operationResult({ ok: true, content: 'Error: sample text', stdout: 'failure' }).outcome).toBe('success');
  });
  it('preserves sync return values and synchronous errors; finish is idempotent', () => {
    expect(observePluginHandler(context, () => 42)).toBe(42);
    const privateFailure = new Error('PRIVATE: /path/token https://private');
    expect(() => observePluginHandler(context, () => { throw privateFailure; })).toThrow(privateFailure);
    const span = startPluginOperation(context);
    span.finish({ outcome: 'conflict' });
    span.finish({ ok: false });
    expect(events().filter((row) => row.event === 'operation.finish')).toHaveLength(3);
    expect(JSON.stringify(events())).not.toContain('PRIVATE');
  });
  it('preserves async failure identity and does not log raw payloads', async () => {
    const error = new Error('private response body');
    await expect(observePluginHandler(context, async () => { throw error; })).rejects.toBe(error);
    expect(events().at(-1)).toMatchObject({ outcome: 'error', code: 'exception' });
    expect(JSON.stringify(events())).not.toContain('private response');
  });
  it('observes descriptor tools, retaining executeTimed exception handling', async () => {
    const tool = observePluginTool({
      name: 'sample', description: '', input_schema: { type: 'object' }, readOnly: true,
      execute() { throw new Error('user-facing failure'); },
    }, { plugin: 'sample' });
    expect(await tool.executeTimed({ text: 'private input' })).toContain('user-facing failure');
    expect(events().filter((row) => row.operation === 'tool.execute' && row.event === 'operation.finish')).toHaveLength(1);
    expect(JSON.stringify(events())).not.toMatch(/private input|user-facing failure/);
  });
  it('automatically observes action-only hosts, command and panel handlers and setup/dispose', async () => {
    const manager = new PluginManager();
    const panels = new PluginPanelRegistry();
    const commands = new micaCommands.CommandRegistry();
    const hooks = new HookRegistry();
    const manifest = parsePluginManifest({
      id: 'sample', name: 'Sample', version: '1.0.0',
      actions: [{ key: 'run', label: 'Run' }], desktop: { panel: { label: 'Sample' } },
    });
    if (!manifest.ok) throw new Error(manifest.error);
    manager.register({ id: 'sample', version: '1.0.0', manifest: manifest.manifest, setup(ctx) {
      ctx.commands.register({ name: 'sample', pluginId: 'sample', handler: () => ({ ok: false, error: 'private' }) });
      ctx.actions!.register('run', () => ({ message: 'private success' }));
      ctx.desktop!.panel!({ view: () => ({ title: 'private' }), action: () => ({ message: 'private' }) });
      ctx.hooks.on('probe', () => 7);
    } });
    await manager.setupAll({ commands, hooks, services: new ServiceContainer(), events: new micaRuntime.RuntimeEventBus(), desktop: { host: 'desktop' }, desktopPanels: panels });
    try {
      expect(await commands.execute('/sample')).toMatchObject({ ok: false });
      await manager.runPluginAction('sample', 'run', { values: {} });
      await panels.get('sample')!.view({ role: 'default' });
      await panels.get('sample')!.action({ action: 'run' });
      expect(hooks.pipelineSync('probe', 1)).toBe(7);
    } finally { await manager.disposeAll(); }
    expect(new Set(events().filter((row) => row.event === 'operation.finish').map((row) => row.operation))).toEqual(new Set([
      'lifecycle.setup', 'command.execute', 'action.execute', 'panel.view', 'panel.action', 'hook.execute', 'lifecycle.dispose',
    ]));
    expect(JSON.stringify(events())).not.toContain('private');
    expect(commands.list()).toEqual([]);
  });
  it('keeps data synchronous and treats a question timing out as cancellation, not failure', async () => {
    let ctx!: PluginContext;
    const manager = new PluginManager();
    const answer = { optionIds: [], cancelled: true, reason: 'timeout' as const };
    manager.register({ id: 'sample-data', setup(value) { ctx = value; } });
    const home = process.env.MICA_HOME!;
    await manager.setupAll({
      paths: { home, config: home, plugins: home }, hooks: new HookRegistry(), commands: new micaCommands.CommandRegistry(),
      services: new ServiceContainer(), events: new micaRuntime.RuntimeEventBus(),
      askFor: () => ({ request: async () => answer, post: () => ({ id: 'q', answered: Promise.resolve(answer), dismiss() {} }) }),
    });
    try {
      expect(ctx.data!.write({ text: 'private body' })).toMatchObject({ ok: true });
      const result = ctx.data!.read();
      expect(result).toMatchObject({ value: { text: 'private body' } });
      expect(result).not.toHaveProperty('then');
      const question = { title: 'private title', options: [{ id: 'a', label: 'private choice' }] };
      await ctx.ask!.request(question);
      await ctx.ask!.post(question).answered;
      const finishes = events().filter((row) => row.event === 'operation.finish');
      expect(finishes.filter((row) => row.operation === 'ask.answer')).toHaveLength(2);
      expect(finishes.filter((row) => row.operation === 'ask.answer').every((row) => row.outcome === 'cancelled')).toBe(true);
      expect(JSON.stringify(events())).not.toMatch(/private body|private title|private choice/);
    } finally { await manager.disposeAll(); }
  });
});

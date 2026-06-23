import { describe, expect, it, vi } from 'vitest';
import { micaCommands } from '@packages/mica-commands/index.js';
import { micaPlugin } from '@packages/mica-plugin/index.js';
import type { RuntimeInput } from '@packages/mica-runtime/index.js';
import { micaRuntime } from '@packages/mica-runtime/index.js';
import { MessageQueuePlugin } from './messageQueuePlugin.js';
import type { AgentRuntime } from '../../agent/AgentRuntime.js';
import type { LocalRuntimeController } from '../../app/adapters/LocalRuntimeController.js';

describe('MessageQueuePlugin', () => {
  it('queues busy input for the event owner instead of the active queue owner', async () => {
    const hooks = new micaPlugin.HookRegistry();
    const owner = { id: 'owner' } as unknown as AgentRuntime;
    const activeOwner = { id: 'active-owner' } as unknown as AgentRuntime;
    const queues = new Map<AgentRuntime, RuntimeInput[]>();
    const published: unknown[] = [];
    const input = micaRuntime.createRuntimeInput('background follow-up');

    const runtime = {
      isAgentBusy: vi.fn((agent?: AgentRuntime) => agent === owner),
      getQueueOwner: vi.fn(() => activeOwner),
      enqueueForAgent: vi.fn((agent: AgentRuntime, item: RuntimeInput) => {
        queues.set(agent, [...(queues.get(agent) ?? []), item]);
        return true;
      }),
      listQueueForAgent: vi.fn((agent: AgentRuntime) => queues.get(agent) ?? []),
      countQueueForAgent: vi.fn((agent: AgentRuntime) => queues.get(agent)?.length ?? 0),
      events: {
        publish: vi.fn((event: unknown) => published.push(event)),
      },
    } as unknown as LocalRuntimeController;

    new MessageQueuePlugin().setup({
      pluginId: 'test.messageQueue',
      hooks,
      commands: new micaCommands.CommandRegistry(),
      services: new micaPlugin.ServiceContainer(),
      events: runtime.events,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      onDispose: vi.fn(),
    });

    const result = await hooks.guard('input:received', {
      runtime,
      input,
      isCommand: false,
      owner,
    });

    expect(result).toMatchObject({ handled: true, blocked: false, reason: 'queued' });
    expect(runtime.enqueueForAgent).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({ ...input, queueMode: 'after_iteration' }),
    );
    expect(runtime.enqueueForAgent).not.toHaveBeenCalledWith(activeOwner, input);
    expect(queues.get(owner)).toEqual([expect.objectContaining({ ...input, queueMode: 'after_iteration' })]);
    expect(queues.get(activeOwner)).toBeUndefined();
    expect(published).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'queue:changed',
          pendingInputs: [expect.objectContaining({ ...input, queueMode: 'after_iteration' })],
          owner,
        }),
        expect.objectContaining({
          type: 'notification',
          owner,
        }),
      ]),
    );
  });

  it('does not append a second pending input for the same owner', async () => {
    const hooks = new micaPlugin.HookRegistry();
    const owner = { id: 'owner' } as unknown as AgentRuntime;
    const published: unknown[] = [];
    const input = micaRuntime.createRuntimeInput('second follow-up', 'ui', { queueMode: 'after_turn' });

    const runtime = {
      isAgentBusy: vi.fn((agent?: AgentRuntime) => agent === owner),
      getQueueOwner: vi.fn(() => owner),
      enqueueForAgent: vi.fn(() => false),
      listQueueForAgent: vi.fn(() => [micaRuntime.createRuntimeInput('first follow-up')]),
      countQueueForAgent: vi.fn(() => 1),
      events: {
        publish: vi.fn((event: unknown) => published.push(event)),
      },
    } as unknown as LocalRuntimeController;

    new MessageQueuePlugin().setup({
      pluginId: 'test.messageQueue',
      hooks,
      commands: new micaCommands.CommandRegistry(),
      services: new micaPlugin.ServiceContainer(),
      events: runtime.events,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      onDispose: vi.fn(),
    });

    const result = await hooks.guard('input:received', {
      runtime,
      input,
      isCommand: false,
      owner,
    });

    expect(result).toMatchObject({ handled: true, blocked: false, reason: 'queue_full' });
    expect(runtime.enqueueForAgent).toHaveBeenCalledWith(owner, input);
    expect(published).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'notification',
          level: 'warn',
          owner,
        }),
      ]),
    );
  });
});

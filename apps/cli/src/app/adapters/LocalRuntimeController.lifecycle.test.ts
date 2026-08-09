import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntime } from '../../agent/AgentRuntime.js';
import type { SubagentTaskManager } from '../../agents/SubagentTaskManager.js';
import { LocalRuntimeController } from './LocalRuntimeController.js';

describe('LocalRuntimeController lifecycle', () => {
  it('kills running subagents when aborting even if the parent turn already finished', async () => {
    const agent = { abort: vi.fn() } as unknown as AgentRuntime;
    const subagentTasks = {
      killRunningForOwner: vi.fn(() => 1),
    } as unknown as Pick<SubagentTaskManager, 'killRunningForOwner'>;
    const runtime = new LocalRuntimeController(
      agent,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      subagentTasks,
    );

    await expect(runtime.abort()).resolves.toEqual({ ok: true });
    expect(subagentTasks.killRunningForOwner).toHaveBeenCalledWith(agent, 'Parent turn was aborted.');
    expect(agent.abort).not.toHaveBeenCalled();
  });
});

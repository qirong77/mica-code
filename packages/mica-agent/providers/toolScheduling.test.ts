import { afterEach, describe, expect, it } from 'vitest';
import { MicaTool, micaTools } from '@packages/mica-tools/index.js';
import { executeProviderToolCalls } from './providerHelpers.js';

const registered: MicaTool[] = [];

afterEach(() => {
  for (const tool of registered.splice(0)) micaTools.unregisterRuntime(tool);
});

describe('provider tool scheduling', () => {
  it('starts an overlappable wait together with the serial calls after it', async () => {
    const events: string[] = [];
    const gate = createGate(2);
    register(new ScriptedTool('probe_wait', false, { events, gate, overlappable: true, output: 'waited' }));
    register(new ScriptedTool('probe_write', false, { events, gate, output: 'written' }));

    const outcomes = await executeProviderToolCalls({
      calls: [call('probe_wait', 'call-wait'), call('probe_write', 'call-write')],
      context: undefined,
      toolFilter: undefined,
    });

    expect(events.slice(0, 2).sort()).toEqual(['start:probe_wait', 'start:probe_write']);
    expect(events.slice(2).sort()).toEqual(['finish:probe_wait', 'finish:probe_write']);
    expect(outcomes.map((outcome) => [outcome.id, outcome.result])).toEqual([
      ['call-wait', 'waited'],
      ['call-write', 'written'],
    ]);
  });

  it('keeps non-read-only calls serial when nothing overlaps', async () => {
    const events: string[] = [];
    register(new ScriptedTool('probe_write_a', false, { events, output: 'a' }));
    register(new ScriptedTool('probe_write_b', false, { events, output: 'b' }));

    await executeProviderToolCalls({
      calls: [call('probe_write_a', 'a'), call('probe_write_b', 'b')],
      context: undefined,
      toolFilter: undefined,
    });

    expect(events).toEqual(['start:probe_write_a', 'finish:probe_write_a', 'start:probe_write_b', 'finish:probe_write_b']);
  });
});

type ScriptedToolOptions = {
  events: string[];
  output: string;
  gate?: Gate;
  overlappable?: boolean;
};

class ScriptedTool extends MicaTool {
  constructor(name: string, readOnly: boolean, script: ScriptedToolOptions) {
    super(name, 'scripted test tool', { type: 'object', properties: {} }, { readOnly, overlappable: script.overlappable });
    this.script = script;
  }

  private readonly script: ScriptedToolOptions;

  async execute(): Promise<string> {
    this.script.events.push(`start:${this.name}`);
    if (this.script.gate) await this.script.gate.wait();
    this.script.events.push(`finish:${this.name}`);
    return this.script.output;
  }

  onToolUseDisplayText(): string {
    return this.name;
  }
}

type Gate = {
  wait(): Promise<void>;
  release(): void;
};

/** 两个调用都要等对方起来才放行：串行执行必然死锁，只有重叠才能跑完。 */
function createGate(expected: number): Gate {
  const resolvers: Array<() => void> = [];
  let started = 0;
  const release = () => {
    for (const resolve of resolvers.splice(0)) resolve();
  };
  return {
    async wait() {
      started++;
      if (started >= expected) {
        release();
        return;
      }
      await new Promise<void>((resolve) => {
        resolvers.push(resolve);
        if (started >= expected) release();
      });
    },
    release,
  };
}

function register(tool: MicaTool): void {
  registered.push(tool);
  micaTools.registerRuntime(tool);
}

function call(name: string, id: string) {
  return { name, argsText: '{}', id, parseArgs: () => ({}) };
}

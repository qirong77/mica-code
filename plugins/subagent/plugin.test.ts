import type {
  PluginContext,
  PluginPromptSection,
  PluginSubagentRunResult,
  PluginSubagentType,
  PluginToolRegistrationOptions,
} from '@packages/mica-plugin/index.js';
import { parsePluginManifest } from '@packages/mica-plugin/index.js';
import type { MicaTool } from '@packages/mica-tools/index.js';
import { describe, expect, it } from 'vitest';
import setup from './index.js';
import { buildDelegationGuidance, DELEGATION_GUIDANCE } from './prompt.js';
import manifest from './plugin.json';

describe('subagent plugin', () => {
  it('registers every builtin type, the agent tool and the delegation section', () => {
    const harness = createHarness();

    expect(harness.types.map((type) => type.name)).toEqual([
      'general-purpose',
      'Explore',
      'Implementer',
      'Reviewer',
      'Tester',
      'Planner',
      'Proposal',
    ]);
    expect(harness.tools).toHaveLength(1);
    expect(harness.tools[0]?.tool.name).toBe('agent');
    expect(harness.tools[0]?.options).toEqual({ primaryAgentOnly: true });
    expect(harness.sections).toHaveLength(1);
    expect(harness.sections[0]?.id).toBe('delegation');
    expect(harness.sections[0]?.render()).toBe(DELEGATION_GUIDANCE);
  });

  it('gives back every registration on dispose so a disabled plugin leaves nothing behind', () => {
    const harness = createHarness();

    harness.dispose();

    expect(harness.types).toHaveLength(0);
    expect(harness.tools).toHaveLength(0);
    expect(harness.sections).toHaveLength(0);
  });

  it('declares a manifest the loader accepts', () => {
    const result = parsePluginManifest(manifest);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.id).toBe('subagent');
    expect(result.manifest.required).toBe(false);
    expect([...result.manifest.requires].sort()).toEqual(['prompt', 'settings', 'subagents', 'tools']);
    expect(result.manifest.settings.map((field) => field.key)).toEqual(['delegationMode']);
  });

  it('switches the delegation tendency from the plugin setting', () => {
    const harness = createHarness({ delegationMode: 'on-request' });

    expect(harness.sections[0]?.render()).toBe(buildDelegationGuidance('on-request'));
    expect(harness.sections[0]?.render()).not.toBe(DELEGATION_GUIDANCE);
  });

  it('refuses to run on a host that has no subagent capability', () => {
    const ctx = createHarness().ctx as { subagents?: unknown };
    const stripped = { ...ctx, subagents: undefined } as unknown as PluginContext;

    expect(() => setup(stripped)).toThrow('requires ctx.subagents');
  });
});

function createHarness(settingsValues: Record<string, string> = {}): {
  ctx: PluginContext;
  types: PluginSubagentType[];
  tools: { tool: MicaTool; options?: PluginToolRegistrationOptions }[];
  sections: PluginPromptSection[];
  dispose: () => void;
} {
  const types: PluginSubagentType[] = [];
  const tools: { tool: MicaTool; options?: PluginToolRegistrationOptions }[] = [];
  const sections: PluginPromptSection[] = [];
  const disposers: Array<() => void> = [];

  const ctx = {
    pluginId: 'subagent',
    subagents: {
      registerType: (type: PluginSubagentType) => {
        types.push(type);
        return {
          dispose: () => {
            const index = types.indexOf(type);
            if (index >= 0) types.splice(index, 1);
          },
        };
      },
      listTypes: () => [...types],
      getType: (name: string | undefined) => types.find((type) => type.name === name) ?? null,
      run: async (): Promise<PluginSubagentRunResult> => ({ taskId: 'task-1', status: 'completed', output: '' }),
      background: () => ({
        taskId: 'task-1',
        done: Promise.resolve({ taskId: 'task-1', status: 'completed' as const, output: '' }),
      }),
      tasks: {
        list: () => [],
        get: () => null,
        kill: () => false,
        wait: async () => [],
      },
      caller: () => null,
    },
    tools: {
      register: (tool: MicaTool, options?: PluginToolRegistrationOptions) => {
        tools.push({ tool, options });
        return {
          dispose: () => {
            const index = tools.findIndex((entry) => entry.tool === tool);
            if (index >= 0) tools.splice(index, 1);
          },
        };
      },
    },
    prompt: {
      section: (section: PluginPromptSection) => {
        sections.push(section);
        return {
          dispose: () => {
            const index = sections.indexOf(section);
            if (index >= 0) sections.splice(index, 1);
          },
        };
      },
    },
    settings: { path: null, get: () => settingsValues, validate: () => [] },
    health: { report: () => undefined },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    onDispose: (dispose: () => void) => disposers.push(dispose),
  } as unknown as PluginContext;

  setup(ctx);

  return {
    ctx,
    types,
    tools,
    sections,
    dispose: () => {
      for (const dispose of [...disposers].reverse()) dispose();
    },
  };
}

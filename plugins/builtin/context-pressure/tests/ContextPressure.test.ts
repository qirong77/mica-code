import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { commandHostToken } from '@packages/mica-builtin-commands/commandHost.js';
import { micaUi } from '@packages/mica-ui/index.js';
import {
  CONTEXT_RESET_RATIO_THRESHOLD,
  getContextRatioColorIndex,
  getContextTokenColorIndex,
  isContextInRedZone,
} from '@packages/mica-ui/panels/contextThresholds.js';
import setupContextPressure from '../ContextPressurePlugin.js';

const WINDOW = 1_000_000;

function mount() {
  const submit = vi.fn(async (_id: string, _text: string, _options?: unknown) => ({ ok: true }));
  const disposers: Array<() => void> = [];
  const services = {
    getCurrentAgentSessionId: () => 'sess-1',
    submitAgentSessionInput: submit,
  };
  const ctx = {
    pluginId: 'test.context-pressure',
    services: {
      get: (token: unknown) => (token === commandHostToken ? { services } : undefined),
    },
    hooks: { on: () => ({ dispose: () => undefined }) },
    events: { publish: () => undefined },
    onDispose: (fn: () => void) => disposers.push(fn),
  } as unknown as PluginContext;
  setupContextPressure(ctx);
  return { submit, dispose: () => disposers.forEach((fn) => fn()) };
}

describe('context thresholds (shared with WorkingStatus UI)', () => {
  it('colors ratio levels like the status bar', () => {
    expect(getContextRatioColorIndex(0.39 * WINDOW, WINDOW)).toBe(0);
    expect(getContextRatioColorIndex(0.5 * WINDOW, WINDOW)).toBe(2);
    expect(getContextRatioColorIndex(0.7 * WINDOW, WINDOW)).toBe(4); // red
  });

  it('colors token levels like the status bar', () => {
    expect(getContextTokenColorIndex(80_000)).toBe(1);
    expect(getContextTokenColorIndex(300_000)).toBe(4); // red
    expect(getContextTokenColorIndex(299_999)).toBe(3);
  });

  it('detects the red zone by ratio or tokens', () => {
    // small window keeps the token dimension below its red line, isolating the ratio
    const small = 100_000;
    expect(isContextInRedZone(0.69 * small, small)).toBe(false);
    expect(isContextInRedZone(0.7 * small, small)).toBe(true);
    expect(isContextInRedZone(299_999, WINDOW)).toBe(false);
    expect(isContextInRedZone(300_000, WINDOW)).toBe(true);
  });

  it('exposes a reset ratio below the warning latch', () => {
    expect(CONTEXT_RESET_RATIO_THRESHOLD).toBe(0.5);
  });
});

describe('context-pressure plugin', () => {
  afterEach(() => {
    micaUi.panels.contextSize.set(0);
    micaUi.panels.modelDisplay.contextWindowSize.set(0);
  });

  it('injects a reminder user message once in the red zone', async () => {
    micaUi.panels.modelDisplay.contextWindowSize.set(WINDOW);
    const { submit, dispose } = mount();
    micaUi.panels.contextSize.set(800_000);
    expect(submit).toHaveBeenCalledTimes(1);
    const [sessionId, text, options] = submit.mock.calls[0]!;
    expect(sessionId).toBe('sess-1');
    expect(text).toContain('80%');
    expect(text).toContain('session_compact');
    expect(options).toMatchObject({ queueMode: 'after_turn' });
    dispose();
  });

  it('does not re-inject while still in the red zone', async () => {
    micaUi.panels.modelDisplay.contextWindowSize.set(WINDOW);
    const { submit, dispose } = mount();
    micaUi.panels.contextSize.set(800_000);
    micaUi.panels.contextSize.set(850_000);
    expect(submit).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('re-arms only after usage drops below the reset ratio', async () => {
    vi.useFakeTimers();
    micaUi.panels.modelDisplay.contextWindowSize.set(WINDOW);
    const { submit, dispose } = mount();
    micaUi.panels.contextSize.set(800_000);
    expect(submit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(61_000); // past the reminder cooldown
    // still red (650k tokens > 300k line) -> no re-arm
    micaUi.panels.contextSize.set(650_000);
    micaUi.panels.contextSize.set(800_000);
    expect(submit).toHaveBeenCalledTimes(1);
    // drops below both red lines and the 0.5 ratio latch -> re-armed
    micaUi.panels.contextSize.set(250_000);
    micaUi.panels.contextSize.set(800_000);
    expect(submit).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
    dispose();
  });

  it('stays silent while the window size is unknown', async () => {
    const { submit, dispose } = mount();
    micaUi.panels.contextSize.set(800_000); // windowSize 0: no ratio available
    expect(submit).not.toHaveBeenCalled();
    micaUi.panels.modelDisplay.contextWindowSize.set(WINDOW);
    micaUi.panels.contextSize.set(1); // force a change event
    micaUi.panels.contextSize.set(800_000);
    expect(submit).toHaveBeenCalledTimes(1);
    dispose();
  });
});

import type { PluginContext } from '@packages/mica-plugin/index.js';
import type { CommandRuntimeServices } from '@packages/mica-builtin-commands/index.js';
import { commandHostToken } from '@packages/mica-builtin-commands/commandHost.js';
import { micaUi } from '@packages/mica-ui/index.js';
import {
  CONTEXT_RESET_RATIO_THRESHOLD,
  isContextInRedZone,
} from '@packages/mica-ui/panels/contextThresholds.js';

/**
 * Re-injecting the reminder while the previous reminder's reply turn is still
 * running would double the cost; the warned latch already prevents that, and
 * this interval is a safety net for consecutive turns that each push the
 * context further into the red zone.
 */
const WARN_REMINDER_INTERVAL_MS = 60_000;

export default function setupContextPressure(ctx: PluginContext): void {
  const host = ctx.services.get(commandHostToken);
  if (!host) throw new Error('context-pressure requires the builtin command host');
  const services: CommandRuntimeServices = host.services;

  let warned = false;
  let lastWarnAt = 0;

  const evaluate = (contextTokens: number): void => {
    const sessionId = services.getCurrentAgentSessionId();
    if (!sessionId || contextTokens <= 0) return;
    const windowSize = micaUi.panels.modelDisplay.contextWindowSize.get();
    // The token-count dimension can be red even before the model rule loads
    // (e.g. 300k tokens with an unknown window). Coloring is harmless but
    // injecting a reminder starts a whole turn, so stay conservative until
    // the window size is known.
    if (windowSize <= 0) return;
    const ratio = windowSize > 0 ? contextTokens / windowSize : 0;

    if (!isContextInRedZone(contextTokens, windowSize)) {
      // Only reset after the usage drops comfortably below the red zone so a
      // value flickering across the boundary does not re-trigger every turn.
      if (ratio < CONTEXT_RESET_RATIO_THRESHOLD) warned = false;
      return;
    }
    if (warned || Date.now() - lastWarnAt < WARN_REMINDER_INTERVAL_MS) return;

    const pct = Math.round(ratio * 100);
    const text = `（系统自动提醒）当前上下文占用已达 ${pct}%（${contextTokens.toLocaleString()} tokens）。如果对话历史过长，请使用 session_compact 工具压缩历史后再继续。`;
    warned = true;
    lastWarnAt = Date.now();
    void services.submitAgentSessionInput(sessionId, text, {
      queueMode: 'after_turn',
      displayText: `（系统提醒）上下文占用 ${pct}%，建议压缩`,
    });
  };

  // contextSize is updated whenever a turn finishes (usage event / session
  // restore), which is exactly when the agent is idle and a reminder can be
  // submitted. Subscribe fires once immediately with the current value; 0
  // never triggers the red zone.
  const unsubscribeSize = micaUi.panels.contextSize.subscribe((value) => {
    if (typeof value === 'number') evaluate(value);
  });
  ctx.onDispose(() => unsubscribeSize());
}

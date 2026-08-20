import type { PluginContext } from '@packages/mica-plugin/index.js';
import type { CommandRuntimeServices } from '@packages/mica-builtin-commands/index.js';
import { commandHostToken } from '@packages/mica-builtin-commands/commandHost.js';
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

/**
 * Watches `context:changed` events (published by the runtime bridge in TUI
 * mode and by the headless plugin host in app-server/exec mode) and, once the
 * context is in the red zone, submits a user message asking the model to
 * compact the conversation. Event-driven so TUI and headless share the exact
 * same behavior.
 */
export default function setupContextPressure(ctx: PluginContext): void {
  const host = ctx.services.get(commandHostToken);
  if (!host) throw new Error('context-pressure requires the builtin command host');
  const services: CommandRuntimeServices = host.services;

  let warned = false;
  let lastWarnAt = 0;

  const evaluate = (contextTokens: number, windowSize: number): void => {
    const sessionId = services.getCurrentAgentSessionId();
    if (!sessionId || contextTokens <= 0) return;
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
    // Inject at the next completed tool iteration boundary (same provider loop)
    // instead of waiting for the current turn to finish: the agent sees the
    // reminder right after the next tool call and can compact immediately
    // instead of finishing all remaining work first. If the turn ends with no
    // further iteration, the message-queue plugin's turn:after dequeue still
    // sends it as a fallback (dequeue does not filter by queueMode).
    void services.submitAgentSessionInput(sessionId, text, {
      queueMode: 'after_iteration',
      displayText: `（系统提醒）上下文占用 ${pct}%，建议压缩`,
    });
  };

  // context:changed is published after every model request (each tool
  // iteration and turn completion), so the reminder can reach an in-flight
  // turn at its next iteration boundary. tokens 0 never triggers the red zone.
  const eventDisposable = ctx.events.on('event', (event) => {
    if (event.type !== 'context:changed') return;
    evaluate(event.tokens, event.windowSize);
  });
  ctx.onDispose(() => eventDisposable.dispose());
}

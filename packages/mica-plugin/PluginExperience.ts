import { createHash, randomUUID } from 'node:crypto';
import type { PluginContext } from './PluginContext.js';

export const EXPERIENCE_SCHEMA_VERSION = 1;
export const EXPERIENCE_LOG_EVENT = 'plugin:experience';
export const EXPERIENCE_EVENTS = ['impression', 'click', 'dismiss', 'update', 'failure', 'check', 'clear'] as const;
export type ExperienceEvent = (typeof EXPERIENCE_EVENTS)[number];
export type ExperienceFields = {
  surface?: 'card' | 'panel' | 'tool' | 'background';
  action?: string;
  outcome?: 'success' | 'error' | 'stale' | 'dismissed';
  revision?: string;
  durationMs?: number;
  count?: number;
};
export type ExperienceRecord = ExperienceFields & {
  schemaVersion: 1;
  eventId: string;
  pluginVersion: string;
  event: ExperienceEvent;
  sessionKey?: string;
};

/** Local, optional usage metadata. Never attach user text, URLs, commands, or paths. */
export function createPluginExperience(ctx: PluginContext, pluginVersion = '1.0.0') {
  const enabled = () => ctx.settings.get().telemetry !== 'false';
  return {
    enabled,
    track(event: ExperienceEvent, fields: ExperienceFields = {}, owner?: unknown): void {
      try {
        if (!enabled() || !EXPERIENCE_EVENTS.includes(event)) return;
        const sessionId = ctx.session?.describe(owner)?.id;
        const data: ExperienceRecord = {
          schemaVersion: EXPERIENCE_SCHEMA_VERSION,
          eventId: randomUUID(),
          pluginVersion,
          event,
          ...(sessionId ? { sessionKey: createHash('sha256').update(sessionId).digest('hex').slice(0, 24) } : {}),
        };
        if (['card', 'panel', 'tool', 'background'].includes(fields.surface ?? '')) data.surface = fields.surface;
        if (['success', 'error', 'stale', 'dismissed'].includes(fields.outcome ?? '')) data.outcome = fields.outcome;
        if (typeof fields.action === 'string' && /^[a-z][a-z0-9:_-]{0,47}$/.test(fields.action))
          data.action = fields.action;
        // Revisions are opaque identifiers, never summaries or endpoint addresses.
        if (typeof fields.revision === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(fields.revision))
          data.revision = fields.revision;
        if (Number.isFinite(fields.durationMs) && fields.durationMs! >= 0)
          data.durationMs = Math.min(Math.round(fields.durationMs!), 3_600_000);
        if (Number.isSafeInteger(fields.count) && fields.count! >= 0) data.count = Math.min(fields.count!, 10_000);
        ctx.logger.info(EXPERIENCE_LOG_EVENT, data);
      } catch {
        // Observability must never make a user action fail.
      }
    },
  };
}

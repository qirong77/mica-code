import { EXPERIENCE_EVENTS, EXPERIENCE_LOG_EVENT } from './PluginExperience.js';

export type ExperienceSummary = {
  plugin: string;
  version: string;
  sessions: number;
  events: Record<string, number>;
  surfaces: Record<string, number>;
  actions: Record<string, number>;
  outcomes: Record<string, number>;
  cardImpressions: number;
  cardClicks: number;
  checkDurationSamples: number;
  averageCheckDurationMs: number | null;
};

/** Only consume versioned metadata. Unknown schemas and malformed/truncated log lines are skipped. */
export function summarizePluginExperience(
  lines: Iterable<string>,
  options: { since?: number; plugin?: string } = {},
): ExperienceSummary[] {
  const seen = new Set<string>();
  const groups = new Map<string, { result: ExperienceSummary; sessions: Set<string>; duration: number }>();
  for (const line of lines) {
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || row.event !== EXPERIENCE_LOG_EVENT || typeof row.plugin !== 'string') continue;
    if (options.plugin && row.plugin !== options.plugin) continue;
    if (
      options.since !== undefined &&
      (typeof row.time !== 'string' || !Number.isFinite(Date.parse(row.time)) || Date.parse(row.time) < options.since)
    )
      continue;
    const data = row.data;
    if (
      !data ||
      data.schemaVersion !== 1 ||
      !EXPERIENCE_EVENTS.includes(data.event) ||
      typeof data.eventId !== 'string' ||
      typeof data.pluginVersion !== 'string'
    )
      continue;
    const eventKey = `${row.plugin}:${data.eventId}`;
    if (seen.has(eventKey)) continue;
    seen.add(eventKey);
    const key = JSON.stringify([row.plugin, data.pluginVersion]);
    let group = groups.get(key);
    if (!group) {
      group = {
        result: {
          plugin: row.plugin,
          version: data.pluginVersion,
          sessions: 0,
          events: {},
          surfaces: {},
          actions: {},
          outcomes: {},
          cardImpressions: 0,
          cardClicks: 0,
          checkDurationSamples: 0,
          averageCheckDurationMs: null,
        },
        sessions: new Set(),
        duration: 0,
      };
      groups.set(key, group);
    }
    const summary = group.result;
    increment(summary.events, data.event);
    if (['card', 'panel', 'tool', 'background'].includes(data.surface))
      increment(summary.surfaces, `${data.surface}:${data.event}`);
    if (typeof data.action === 'string' && /^[a-z][a-z0-9:_-]{0,47}$/.test(data.action))
      increment(summary.actions, `${data.event}:${data.action}`);
    if (['success', 'error', 'stale', 'dismissed'].includes(data.outcome))
      increment(summary.outcomes, `${data.event}:${data.outcome}`);
    if (typeof data.sessionKey === 'string' && /^[a-f0-9]{24}$/.test(data.sessionKey))
      group.sessions.add(data.sessionKey);
    if (data.surface === 'card' && data.event === 'impression') summary.cardImpressions++;
    if (data.surface === 'card' && data.event === 'click') summary.cardClicks++;
    if (
      data.event === 'check' &&
      Number.isFinite(data.durationMs) &&
      data.durationMs >= 0 &&
      data.durationMs <= 3_600_000
    ) {
      group.duration += data.durationMs;
      summary.checkDurationSamples++;
    }
  }
  return [...groups.values()]
    .map(({ result, sessions, duration }) => ({
      ...result,
      sessions: sessions.size,
      averageCheckDurationMs: result.checkDurationSamples ? Math.round(duration / result.checkDurationSamples) : null,
    }))
    .sort((a, b) => a.plugin.localeCompare(b.plugin) || a.version.localeCompare(b.version));
}

function increment(record: Record<string, number>, key: string) {
  Object.defineProperty(record, key, {
    value: (Object.hasOwn(record, key) ? record[key]! : 0) + 1,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

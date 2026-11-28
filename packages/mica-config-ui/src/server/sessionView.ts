import type { PersistedRuntimeSnapshot, PersistedSession } from '@packages/mica-session/sessionStore.js';
import { countUsageRequests } from '@packages/mica-web-shared/usage-source.js';
import type { ConfigWebConversationItem, ConfigWebConversationPage, ConfigWebSessionDetails } from '../shared/types.js';
import { buildConfigWebConversationItems, type ConfigWebConversationSource } from './conversation.js';
import { buildConfigWebContextAnalysis } from './sessionAnalysis.js';

export function buildSessionHeader(
  session: PersistedSession,
  fileSizeBytes: number,
  title = session.title,
): ConfigWebSessionDetails {
  const { id, createdAt, updatedAt, cwd, turnState, snapshot } = session;
  const { providerId, model, role, contextWindowSize, turnTimings, lastUsage } = snapshot;
  return {
    id,
    title,
    createdAt,
    updatedAt,
    cwd,
    turnState,
    providerId,
    model,
    role,
    fileSizeBytes,
    messageCount: snapshot.messages.length,
    usageCount: countUsageRequests(snapshot),
    contextWindowSize,
    turnTimings,
    lastUsage: lastUsage
      ? {
          inputTokens: lastUsage.inputTokens,
          cachedInputTokens: lastUsage.cachedInputTokens,
          outputTokens: lastUsage.outputTokens,
          totalTokens: lastUsage.totalTokens,
        }
      : undefined,
  };
}

type RolePrompt = (name: string) => string;

function conversationSource(snapshot: PersistedRuntimeSnapshot, rolePrompt: RolePrompt): ConfigWebConversationSource {
  const { providerId, protocol, model, messages, systemPrompt, role } = snapshot;
  return { providerId, protocol, model, messages, systemPrompt: systemPrompt ?? rolePrompt(role) };
}

export function sessionConversationItems(snapshot: PersistedRuntimeSnapshot, rolePrompt: RolePrompt) {
  return buildConfigWebConversationItems(conversationSource(snapshot, rolePrompt));
}

export function sessionContextAnalysis(snapshot: PersistedRuntimeSnapshot, rolePrompt: RolePrompt) {
  return buildConfigWebContextAnalysis(conversationSource(snapshot, rolePrompt), snapshot);
}

export function sliceConversationPage(
  id: string,
  items: ConfigWebConversationItem[],
  offset: number,
  limit: number,
  tail = false,
): ConfigWebConversationPage {
  const total = items.length;
  const start = tail ? Math.max(0, total - limit) : clampInt(offset, 0, Math.max(0, total - 1));
  const end = Math.min(total, start + clampInt(limit, 1, 500));
  return { id, total, offset: start, limit: end - start, items: items.slice(start, end) };
}

export function conversationItemAt(
  items: ConfigWebConversationItem[],
  sequence: number,
): ConfigWebConversationItem | undefined {
  return items[clampInt(sequence, 1, items.length) - 1];
}

function clampInt(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : min;
}

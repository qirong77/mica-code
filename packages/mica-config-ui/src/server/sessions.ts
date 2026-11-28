import { statSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentRole } from '@packages/mica-agent/prompt/roles.js';
import { applyBrandTemplate } from '@packages/mica-agent/prompt/brandTemplate.js';
import { wrapPromptXml } from '@packages/mica-common/promptXml.js';
import { micaSession, type PersistedSession } from '@packages/mica-session/index.js';
import type { ConfigWebConversationItem, ConfigWebSessionPrompt } from '../shared/types.js';
import { listConfigWebSessions } from './sessionHead.js';
import {
  buildSessionHeader,
  conversationItemAt,
  sessionContextAnalysis,
  sessionConversationItems,
  sliceConversationPage,
} from './sessionView.js';

const SESSION_CACHE_BYTES_BUDGET = 64 * 1024 * 1024;
const ITEMS_CACHE_BYTES_BUDGET = 48 * 1024 * 1024;
const CONTENT_CACHE_ENTRIES = 2;

type CachedEntry<T> = { mtimeMs: number; size: number; value: T };
type LoadedSession = CachedEntry<PersistedSession> & { fileId: string };
const sessionCache = new Map<string, LoadedSession>();
const itemsCache = new Map<string, CachedEntry<ConfigWebConversationItem[]>>();
const contentCache = new Map<string, CachedEntry<string>>();

export function getSessionsDetails() {
  return listConfigWebSessions(micaSession.dir);
}

export function getSessionDetails(id: string) {
  const { value, size } = loadSessionCached(id);
  return buildSessionHeader(value, size);
}

export function writeSessionDetails(id: string, content: string) {
  const session = micaSession.createStore().replaceValidated(id, content);
  sessionCache.delete(session.id);
  itemsCache.delete(session.id);
  contentCache.delete(session.id);
  return getSessionDetails(session.id);
}

export function getSessionConversationPage(id: string, offset: number, limit: number, tail = false) {
  const entry = loadSessionCached(id);
  return sliceConversationPage(entry.value.id, loadConversationItemsCached(entry), offset, limit, tail);
}

export function getSessionItem(id: string, sequence: number) {
  const item = conversationItemAt(loadConversationItemsCached(loadSessionCached(id)), sequence);
  if (!item) throw new Error(`Conversation item not found: sequence ${sequence}`);
  return item;
}

export function getSessionContextAnalysis(id: string) {
  return sessionContextAnalysis(loadSessionCached(id).value.snapshot, currentRolePrompt);
}

export function getSessionSystemPrompt(id: string): ConfigWebSessionPrompt {
  const { snapshot } = loadSessionCached(id).value;
  return { prompt: snapshot.systemPrompt ?? '', rolePrompt: currentRolePrompt(snapshot.role) };
}

function currentRolePrompt(name: string): string {
  const base = wrapPromptXml('system', getAgentRole('default')?.prompt ?? '');
  if (name === 'default') return base;
  const role = getAgentRole(name);
  return role && role.name !== 'default' && role.prompt.trim()
    ? `${base}\n\n${wrapPromptXml('role', applyBrandTemplate(role.prompt))}`
    : base;
}

export function getSessionContent(id: string): { content: string } {
  const { value: session, fileId, mtimeMs, size } = loadSessionCached(id);
  const cached = contentCache.get(fileId);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return { content: cached.value };
  const content = JSON.stringify(session, null, 2);
  contentCache.set(fileId, { mtimeMs, size, value: content });
  if (contentCache.size > CONTENT_CACHE_ENTRIES) contentCache.delete(contentCache.keys().next().value!);
  return { content };
}

function loadSessionCached(id: string): LoadedSession {
  const safeId = id.trim().replace(/\.json$/, '');
  if (!/^[a-zA-Z0-9_.-]+$/.test(safeId)) throw new Error(`Session not found: ${id}`);
  const stat = statSync(join(micaSession.dir, `${safeId}.json`), { throwIfNoEntry: false });
  if (!stat) throw new Error(`Session not found: ${safeId}`);
  const { mtimeMs, size } = stat;
  const cached = sessionCache.get(safeId);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached;
  const session = micaSession.createStore().load(safeId);
  if (!session) throw new Error(`Session not found: ${id}`);
  const entry = { fileId: safeId, mtimeMs, size, value: session };
  sessionCache.set(safeId, entry);
  evictByBytes(sessionCache, SESSION_CACHE_BYTES_BUDGET);
  return entry;
}

function loadConversationItemsCached({ value: session, fileId, mtimeMs, size }: LoadedSession) {
  const cached = itemsCache.get(fileId);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.value;
  const items = sessionConversationItems(session.snapshot, currentRolePrompt);
  itemsCache.set(fileId, { mtimeMs, size, value: items });
  evictByBytes(itemsCache, ITEMS_CACHE_BYTES_BUDGET);
  return items;
}

function evictByBytes<T>(cache: Map<string, CachedEntry<T>>, budget: number): void {
  let total = 0;
  for (const entry of cache.values()) total += entry.size;
  for (const [key, entry] of cache) {
    if (total <= budget) break;
    total -= entry.size;
    cache.delete(key);
  }
}

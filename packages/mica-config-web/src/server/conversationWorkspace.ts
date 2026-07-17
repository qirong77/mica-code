import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { micaAgent } from '@packages/mica-agent/index.js';
import type { AgentCallbacks } from '@packages/mica-agent/core/Agent.js';
import { micaConfig } from '@packages/mica-config/index.js';
import type { EffortOption, ProviderDefinition } from '@packages/mica-config/index.js';
import { micaSession, type PersistedSession } from '@packages/mica-session/index.js';
import { buildConfigWebConversationDetails } from '../conversation.js';
import { getConversationWorkspacePath } from './paths.js';
import type {
  ConfigWebConversationCreateInput,
  ConfigWebConversationDetails,
  ConfigWebConversationFolder,
  ConfigWebConversationFolderInput,
  ConfigWebConversationPatchInput,
  ConfigWebConversationSendInput,
  ConfigWebConversationSummary,
  ConfigWebConversationWorkspace,
  ConfigWebSessionDetails,
} from '../shared/types.js';

type WorkspaceFile = {
  version: 1;
  folders: ConfigWebConversationFolder[];
  conversations: Record<
    string,
    {
      folderId: string | null;
      pinned?: boolean;
    }
  >;
};

const activeConversationSends = new Set<string>();

export class ConversationMessageError extends Error {
  constructor(
    message: string,
    readonly session: ConfigWebSessionDetails,
    readonly inputCommitted: boolean,
  ) {
    super(message);
    this.name = 'ConversationMessageError';
  }
}

const DEFAULT_WORKSPACE: WorkspaceFile = {
  version: 1,
  folders: [],
  conversations: {},
};

export function getConversationWorkspace(): ConfigWebConversationWorkspace {
  const workspace = readWorkspaceFile();
  const store = micaSession.createStore();
  const sessions = store.listRecent(500);
  const summaries: ConfigWebConversationSummary[] = sessions.map((session) => {
    const meta = workspace.conversations[session.id] ?? { folderId: null };
    return {
      id: session.id,
      title: session.title,
      folderId: sanitizeFolderId(meta.folderId, workspace.folders),
      updatedAt: session.updatedAt,
      createdAt: session.createdAt ?? session.updatedAt,
      cwd: session.cwd,
      turnState: session.turnState ?? (session.uncompleted ? 'running' : 'completed'),
      providerId: session.providerId,
      model: session.model,
      effort: session.effort ?? 'none',
      role: session.role ?? 'default',
      pinned: Boolean(meta.pinned),
    };
  });

  summaries.sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  return {
    root: micaSession.dir,
    folders: workspace.folders,
    conversations: summaries,
  };
}

export function createConversation(input: ConfigWebConversationCreateInput = {}): ConfigWebSessionDetails {
  const config = micaConfig.get();
  const provider = resolveProvider(input.providerId ?? config.provider);
  const model = resolveModel(provider, input.model ?? config.model);
  const effort = resolveEffort(provider, model, input.effort ?? config.effort);
  const role = resolveRole(input.role);
  const now = new Date().toISOString();
  const id = micaSession.createId();
  const title = normalizeTitle(input.title) || '新对话';
  const session: PersistedSession = {
    version: 1,
    id,
    title,
    createdAt: now,
    updatedAt: now,
    cwd: process.cwd(),
    turnState: 'completed',
    snapshot: {
      providerId: provider.id,
      protocol: provider.protocol,
      model,
      effort,
      role,
      messages: [],
      conversationMessages: [],
      usageHistory: [],
      lastUsage: undefined,
    },
  };
  micaSession.createStore().save(session);

  const workspace = readWorkspaceFile();
  workspace.conversations[id] = {
    folderId: sanitizeFolderId(input.folderId ?? null, workspace.folders),
    pinned: false,
  };
  writeWorkspaceFile(workspace);
  return toSessionDetails(session);
}

export function patchConversation(input: ConfigWebConversationPatchInput): ConfigWebSessionDetails {
  const store = micaSession.createStore();
  const session = store.load(input.id);
  if (!session) throw new Error(`Conversation not found: ${input.id}`);

  if (typeof input.title === 'string') {
    const title = normalizeTitle(input.title);
    if (!title) throw new Error('title must not be empty');
    session.title = title;
  }

  let provider = resolveProvider(session.snapshot.providerId);
  if (typeof input.providerId === 'string' && input.providerId.trim()) {
    provider = resolveProvider(input.providerId);
    session.snapshot.providerId = provider.id;
    session.snapshot.protocol = provider.protocol;
  }
  if (typeof input.model === 'string' && input.model.trim()) {
    session.snapshot.model = resolveModel(provider, input.model);
  } else {
    session.snapshot.model = resolveModel(provider, session.snapshot.model);
  }
  if (typeof input.effort === 'string' && input.effort.trim()) {
    session.snapshot.effort = resolveEffort(provider, session.snapshot.model, input.effort);
  } else {
    session.snapshot.effort = resolveEffort(provider, session.snapshot.model, session.snapshot.effort);
  }
  if (typeof input.role === 'string' && input.role.trim()) {
    session.snapshot.role = resolveRole(input.role);
  }

  session.updatedAt = new Date().toISOString();
  store.save(session);

  const workspace = readWorkspaceFile();
  const current = workspace.conversations[session.id] ?? { folderId: null as string | null, pinned: false };
  if ('folderId' in input) current.folderId = sanitizeFolderId(input.folderId ?? null, workspace.folders);
  if (typeof input.pinned === 'boolean') current.pinned = input.pinned;
  workspace.conversations[session.id] = current;
  writeWorkspaceFile(workspace);

  return toSessionDetails(session);
}

export function deleteConversation(id: string): ConfigWebConversationWorkspace {
  const store = micaSession.createStore();
  if (!store.delete(id)) throw new Error(`Conversation not found: ${id}`);
  const workspace = readWorkspaceFile();
  delete workspace.conversations[id];
  writeWorkspaceFile(workspace);
  return getConversationWorkspace();
}

export function clearConversation(id: string): ConfigWebSessionDetails {
  const store = micaSession.createStore();
  const session = store.load(id);
  if (!session) throw new Error(`Conversation not found: ${id}`);
  session.snapshot.messages = [];
  session.snapshot.conversationMessages = [];
  session.snapshot.usageHistory = [];
  session.snapshot.lastUsage = undefined;
  session.turnState = 'completed';
  session.updatedAt = new Date().toISOString();
  store.save(session);
  return toSessionDetails(session);
}

export function createConversationFolder(input: ConfigWebConversationFolderInput = {}): ConfigWebConversationWorkspace {
  const name = normalizeTitle(input.name) || '新文件夹';
  const workspace = readWorkspaceFile();
  if (workspace.folders.some((folder) => folder.name === name)) {
    throw new Error(`Folder already exists: ${name}`);
  }
  const id = createId('folder');
  workspace.folders = [{ id, name, collapsed: false }, ...workspace.folders];
  writeWorkspaceFile(workspace);
  return getConversationWorkspace();
}

export function patchConversationFolder(input: ConfigWebConversationFolderInput): ConfigWebConversationWorkspace {
  if (!input.id) throw new Error('id is required');
  const workspace = readWorkspaceFile();
  const index = workspace.folders.findIndex((folder) => folder.id === input.id);
  if (index < 0) throw new Error(`Folder not found: ${input.id}`);
  const current = workspace.folders[index];
  if (typeof input.name === 'string') {
    const name = normalizeTitle(input.name);
    if (!name) throw new Error('name must not be empty');
    if (workspace.folders.some((folder) => folder.id !== current.id && folder.name === name)) {
      throw new Error(`Folder already exists: ${name}`);
    }
    current.name = name;
  }
  if (typeof input.collapsed === 'boolean') current.collapsed = input.collapsed;
  workspace.folders[index] = current;
  writeWorkspaceFile(workspace);
  return getConversationWorkspace();
}

export function deleteConversationFolder(id: string): ConfigWebConversationWorkspace {
  const workspace = readWorkspaceFile();
  if (!workspace.folders.some((folder) => folder.id === id)) throw new Error(`Folder not found: ${id}`);
  workspace.folders = workspace.folders.filter((folder) => folder.id !== id);
  for (const [conversationId, meta] of Object.entries(workspace.conversations)) {
    if (meta.folderId === id) workspace.conversations[conversationId] = { ...meta, folderId: null };
  }
  writeWorkspaceFile(workspace);
  return getConversationWorkspace();
}

export async function sendConversationMessage(
  input: ConfigWebConversationSendInput,
  options: AgentCallbacks & { signal?: AbortSignal } = {},
): Promise<ConfigWebSessionDetails> {
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!id) throw new Error('id is required');
  if (activeConversationSends.has(id)) throw new Error('This conversation is already running');
  activeConversationSends.add(id);
  try {
    return await sendConversationMessageUnlocked(input, options);
  } finally {
    activeConversationSends.delete(id);
  }
}

async function sendConversationMessageUnlocked(
  input: ConfigWebConversationSendInput,
  options: AgentCallbacks & { signal?: AbortSignal },
): Promise<ConfigWebSessionDetails> {
  const content = typeof input.content === 'string' ? input.content.trim() : '';
  if (!content) throw new Error('content must not be empty');

  const store = micaSession.createStore();
  const session = store.load(input.id);
  if (!session) throw new Error(`Conversation not found: ${input.id}`);

  const provider = resolveProvider(session.snapshot.providerId);
  if (!provider.api_key?.trim()) throw new Error(`Provider "${provider.id}" is missing api_key`);
  const model = resolveModel(provider, session.snapshot.model);
  const effort = resolveEffort(provider, model, session.snapshot.effort);
  const role = micaAgent.roles.get(session.snapshot.role) ?? micaAgent.roles.get('default');
  const systemPrompt = micaAgent.buildSystemPrompt({
    baseSystemPrompt: role?.prompt,
    cwd: session.cwd,
  });

  session.turnState = 'running';
  session.updatedAt = new Date().toISOString();
  store.save(session);

  const client = micaAgent.createSubAgent({
    model,
    apiKey: provider.api_key,
    baseURL: provider.api_base,
    effort,
    provider,
    // The default coding prompt explicitly asks the model to use tools. When
    // tools are disabled, some providers emit pseudo XML such as <use_tool>
    // into assistant text instead of making a structured call.
    tools: true,
    toolContext: { cwd: session.cwd },
    systemPrompt,
  });
  let streamedText = '';
  client.onText = (delta) => {
    streamedText += delta;
    options.onText?.(delta);
  };
  client.onThinking = options.onThinking;
  client.onToolCall = options.onToolCall;
  client.onToolResult = options.onToolResult;
  client.onUsage = options.onUsage;
  client.loadSnapshot({
    model: session.snapshot.model,
    messages: session.snapshot.messages as never[],
    usageHistory: session.snapshot.usageHistory as never[],
    lastUsage: session.snapshot.lastUsage as never,
    conversationMessages: [],
  });

  try {
    await client.query(content, { signal: options.signal });
    const snapshot = client.getSnapshot();
    session.snapshot.model = snapshot.model;
    session.snapshot.messages = snapshot.messages as unknown[];
    session.snapshot.usageHistory = snapshot.usageHistory;
    session.snapshot.lastUsage = snapshot.lastUsage;
    session.snapshot.conversationMessages = snapshot.conversationMessages as unknown[];
    session.snapshot.providerId = provider.id;
    session.snapshot.protocol = provider.protocol;
    session.snapshot.effort = effort;
    session.turnState = 'completed';
    if (session.title === '新对话') {
      session.title = deriveTitleFromText(content);
    }
    session.updatedAt = new Date().toISOString();
    store.save(session);
    return toSessionDetails(session);
  } catch (error) {
    const originalMessageCount = session.snapshot.messages.length;
    if (options.signal?.aborted && client.getSnapshot().messages.length === originalMessageCount) {
      client.preserveAbortedTurn(content, streamedText || undefined);
    }
    const snapshot = client.getSnapshot();
    session.snapshot.messages = snapshot.messages as unknown[];
    session.snapshot.usageHistory = snapshot.usageHistory;
    session.snapshot.lastUsage = snapshot.lastUsage;
    session.snapshot.conversationMessages = snapshot.conversationMessages as unknown[];
    session.turnState = options.signal?.aborted ? 'aborted' : 'error';
    session.updatedAt = new Date().toISOString();
    store.save(session);
    throw new ConversationMessageError(
      error instanceof Error ? error.message : String(error),
      toSessionDetails(session),
      snapshot.messages.length > originalMessageCount,
    );
  }
}

function toSessionDetails(session: PersistedSession): ConfigWebSessionDetails {
  const role = micaAgent.roles.get(session.snapshot.role);
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    cwd: session.cwd,
    turnState: session.turnState,
    providerId: session.snapshot.providerId,
    model: session.snapshot.model,
    role: session.snapshot.role,
    content: JSON.stringify(session, null, 2),
    conversation: buildConfigWebConversationDetails(
      {
        providerId: session.snapshot.providerId,
        protocol: session.snapshot.protocol,
        model: session.snapshot.model,
        systemPrompt: role?.prompt ?? '',
        messages: session.snapshot.messages,
      },
      new Date(session.updatedAt),
    ),
  };
}

function readWorkspaceFile(): WorkspaceFile {
  const path = getConversationWorkspacePath();
  if (!existsSync(path)) return structuredClone(DEFAULT_WORKSPACE);
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<WorkspaceFile>;
    if (raw.version !== 1 || !Array.isArray(raw.folders) || !raw.conversations || typeof raw.conversations !== 'object') {
      return structuredClone(DEFAULT_WORKSPACE);
    }
    return {
      version: 1,
      folders: raw.folders
        .filter((folder): folder is ConfigWebConversationFolder => {
          return Boolean(
            folder &&
              typeof folder === 'object' &&
              typeof folder.id === 'string' &&
              typeof folder.name === 'string' &&
              typeof folder.collapsed === 'boolean',
          );
        })
        .map((folder) => ({ id: folder.id, name: folder.name, collapsed: folder.collapsed })),
      conversations: Object.fromEntries(
        Object.entries(raw.conversations).map(([id, meta]) => [
          id,
          {
            folderId: typeof meta?.folderId === 'string' ? meta.folderId : null,
            pinned: Boolean(meta?.pinned),
          },
        ]),
      ),
    };
  } catch {
    return structuredClone(DEFAULT_WORKSPACE);
  }
}

function writeWorkspaceFile(workspace: WorkspaceFile): void {
  const path = getConversationWorkspacePath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(workspace, null, 2)}\n`, 'utf-8');
  renameSync(temporary, path);
}

function sanitizeFolderId(folderId: string | null | undefined, folders: ConfigWebConversationFolder[]): string | null {
  if (!folderId) return null;
  return folders.some((folder) => folder.id === folderId) ? folderId : null;
}

function resolveProvider(providerId: string): ProviderDefinition {
  const config = micaConfig.get();
  const provider = config.providers.find((item) => item.id === providerId) ?? config.providers[0];
  if (!provider) throw new Error('No provider configured');
  return provider;
}

function resolveModel(provider: ProviderDefinition, model: string): string {
  const preferred = model.trim();
  if (preferred && (!provider.models?.length || provider.models.includes(preferred))) return preferred;
  return provider.models?.[0] ?? (preferred || 'unknown');
}

function resolveEffort(provider: ProviderDefinition, model: string, effort: string): EffortOption {
  if (provider.supportsEffort === false) return 'none';
  const normalized = micaConfig.normalizeModelEffort(model, effort as EffortOption);
  return normalized;
}

function resolveRole(role: string | undefined): string {
  const name = (role ?? 'default').trim() || 'default';
  return micaAgent.roles.get(name)?.name ?? 'default';
}

function normalizeTitle(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function deriveTitleFromText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '新对话';
  return normalized.length > 40 ? `${normalized.slice(0, 40)}…` : normalized;
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export type { ConfigWebConversationDetails };

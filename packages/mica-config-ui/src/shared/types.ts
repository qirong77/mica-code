export type ConfigWebSection = 'config' | 'sessions' | 'roles' | 'mcp' | 'skills' | 'plugins' | 'autoCompact';

export type ConfigWebFilePayload = {
  path: string;
  content: string;
};

export type ConfigWebServerInfo = {
  url: string;
  port: number;
  reused: boolean;
};

export type ConfigWebConversationItemType =
  | 'system'
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'reasoning'
  | 'unknown';

export type ConfigWebConversationItem = {
  sequence: number;
  type: ConfigWebConversationItemType;
  content: string;
  callId?: string;
  toolName?: string;
  role?: string;
  /** Payload char size when the content itself is not persisted (e.g. encrypted reasoning). */
  sizeHint?: number;
};

export type ConfigWebConversationDetails = {
  providerId: string;
  protocol: 'openai_chat_completions' | 'openai_responses';
  model: string;
  updatedAt: string;
  items: ConfigWebConversationItem[];
};

export type ConfigWebConversationPage = {
  id: string;
  total: number;
  offset: number;
  limit: number;
  items: ConfigWebConversationItem[];
};

export type ConfigWebMcpTool = {
  name: string;
  description?: string;
};

export type ConfigWebMcpServer = {
  name: string;
  type: 'http' | 'stdio';
  target: string;
  status: 'configured' | 'connecting' | 'connected' | 'failed';
  configPath: string;
  config: string;
  toolCount: number;
  tools: ConfigWebMcpTool[];
  error?: string;
  cwd?: string;
  envKeys?: string[];
};

export type ConfigWebMcpDetails = {
  path: string;
  servers: ConfigWebMcpServer[];
};

export type ConfigWebSkill = {
  name: string;
  description: string;
  whenToUse?: string;
  argumentHint?: string;
  baseDir: string;
  content: string;
  editable: boolean;
};

export type ConfigWebSkillsDetails = {
  root: string;
  skills: ConfigWebSkill[];
};

export type ConfigWebPlugin = {
  name: string;
  id: string;
  file: string;
  content: string;
  extension: string;
  sizeBytes: number;
  updatedAt: string;
  status?: 'loaded' | 'registered' | 'failed' | 'unknown';
  error?: string;
};

export type ConfigWebPluginsDetails = {
  root: string;
  plugins: ConfigWebPlugin[];
};

export type ConfigWebAutoCompactSettings = {
  enabled: boolean;
  quickThresholdK: number;
  quickLimit: number;
  modelThresholdK: number;
  modelLimit: number;
};

/** 一个会话的自动压缩账本（计数只是展示用的，丢了不影响压缩本身）。 */
export type ConfigWebAutoCompactCounter = {
  sessionId: string;
  /** 会话文件还在时是它的标题；会话被删了就只剩 id。 */
  title?: string;
  quickRuns: number;
  modelRuns: number;
  lastRunAt: string | null;
  lastKind: 'quick' | 'model' | null;
  lastSavedTokens: number;
  lastNote: string | null;
};

export type ConfigWebAutoCompactDetails = {
  /** 落盘位置（运行时目录下的 auto-compact.json），页面上直接展示。 */
  path: string;
  settings: ConfigWebAutoCompactSettings;
  /** 运行时的默认值，页面用它实现「恢复默认」。 */
  defaults: ConfigWebAutoCompactSettings;
  counters: ConfigWebAutoCompactCounter[];
};

export type ConfigWebSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  turnState: 'running' | 'completed' | 'aborted' | 'error';
  providerId: string;
  model: string;
  role: string;
};

export type ConfigWebSessionUsage = {
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  totalTokens: number;
};

/** Lightweight session header; heavy payloads are loaded lazily via separate endpoints. */
export type ConfigWebSessionDetails = ConfigWebSession & {
  fileSizeBytes: number;
  messageCount: number;
  usageCount: number;
  contextWindowSize?: number;
  lastUsage?: ConfigWebSessionUsage;
};

export type ConfigWebContextEntry = {
  sequence: number;
  type: ConfigWebConversationItemType;
  label: string;
  tokens: number;
  preview: string;
  images?: number;
};

export type ConfigWebContextTurn = {
  /** 1-based turn number; 0 for a session without any user message. */
  index: number;
  userSequence: number;
  userPreview: string;
  conversationTokens: number;
  toolTokens: number;
  thinkingTokens: number;
  totalTokens: number;
  /** Real input tokens at the end of this turn, from usage history when aligned. */
  contextTokens?: number;
  cachedInputTokens?: number;
  usageRequests: number;
  entries: ConfigWebContextEntry[];
};

export type ConfigWebContextAnalysis = {
  providerId: string;
  model: string;
  contextWindowSize?: number;
  imageCount: number;
  turnCount: number;
  totals: {
    conversationTokens: number;
    toolTokens: number;
    thinkingTokens: number;
    totalTokens: number;
  };
  turns: ConfigWebContextTurn[];
};

export type ConfigWebSessionOption = {
  id: string;
  title: string;
  updatedAt: string;
};

export type ConfigWebSessionsDetails = {
  root: string;
  sessions: ConfigWebSessionOption[];
};

export type ConfigWebRole = {
  name: string;
  content: string;
  builtIn: boolean;
  path?: string;
};

export type ConfigWebRolesDetails = {
  root: string;
  roles: ConfigWebRole[];
};

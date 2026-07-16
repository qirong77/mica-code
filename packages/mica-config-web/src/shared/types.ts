export type ConfigWebSection = 'config' | 'sessions' | 'roles' | 'mcp' | 'skills' | 'plugins';

export type ConfigWebFilePayload = {
  path: string;
  content: string;
};

export type ConfigWebServerInfo = {
  url: string;
  port: number;
  token: string;
  reused: boolean;
};

export type ConfigWebConversationItemType = 'system' | 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'unknown';

export type ConfigWebConversationItem = {
  sequence: number;
  type: ConfigWebConversationItemType;
  content: string;
  callId?: string;
  toolName?: string;
  role?: string;
};

export type ConfigWebConversationDetails = {
  providerId: string;
  protocol: 'openai_chat_completions' | 'openai_responses';
  model: string;
  updatedAt: string;
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

export type ConfigWebSessionDetails = ConfigWebSession & {
  content: string;
  conversation: ConfigWebConversationDetails;
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

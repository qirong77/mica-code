export type ConfigWebSection = 'config' | 'mcp' | 'skills' | 'plugins';

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
  contentPreview: string;
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

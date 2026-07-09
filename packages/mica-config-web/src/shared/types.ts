export type ConfigWebSection = 'config' | 'mcp' | 'skills' | 'plugins';

export type ConfigWebFilePayload = {
  section: ConfigWebSection;
  path?: string;
  content: string;
  updatedAt: string;
};

export type ConfigWebServerInfo = {
  url: string;
  port: number;
  token: string;
  reused: boolean;
};

export type ConfigFieldDescription = {
  key: string;
  title: string;
  description: string;
  example?: string;
};

export type ConfigWebMcpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
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
  updatedAt: string;
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
  updatedAt: string;
};

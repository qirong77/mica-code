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

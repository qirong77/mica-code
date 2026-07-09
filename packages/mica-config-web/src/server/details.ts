import { existsSync } from 'node:fs';
import { micaMcp } from '@packages/mica-mcp/index.js';
import { micaSkills } from '@packages/mica-skills/index.js';
import { getSkillsRootPath } from './paths.js';
import type { McpServerConfig } from '@packages/mica-mcp/index.js';
import type { Skill } from '@packages/mica-skills/index.js';
import type { ConfigFieldDescription, ConfigWebMcpDetails, ConfigWebMcpServer, ConfigWebSkillsDetails } from '../shared/types.js';

let mcpInitialized = false;

export function getConfigFieldDescriptions(): ConfigFieldDescription[] {
  return [
    {
      key: 'providers',
      title: 'providers',
      description: '模型服务商列表。每个 provider 定义 id、api_base、api_key、protocol，以及可选 models。',
      example: '用于配置 OpenAI、Anthropic 或兼容 OpenAI 的模型供应商。',
    },
    {
      key: 'providers[].id',
      title: 'providers[].id',
      description: '服务商唯一标识，会被会话偏好和模型选择引用。建议使用稳定、简短的小写名称。',
    },
    {
      key: 'providers[].api_base',
      title: 'providers[].api_base',
      description: '服务商 API 地址。OpenAI 兼容接口通常以 /v1 结尾。',
    },
    {
      key: 'providers[].api_key',
      title: 'providers[].api_key',
      description: '服务商密钥。保存前请确认当前机器的配置文件权限可信。',
    },
    {
      key: 'providers[].protocol',
      title: 'providers[].protocol',
      description: '请求协议。支持 openai_chat_completions、openai_responses、anthropic_messages。',
    },
    {
      key: 'providers[].models',
      title: 'providers[].models',
      description: '该服务商可用模型列表。为空或省略时，运行时不会限制模型名。',
    },
    {
      key: 'providers[].supportsEffort',
      title: 'providers[].supportsEffort',
      description: '是否支持 reasoning effort。开启后会按模型规则映射 effort 参数。',
    },
    {
      key: 'mcpServers',
      title: 'mcpServers',
      description: 'MCP 服务定义。详情请在 MCP 页面查看，那里会以只读卡片形式展示 server 和工具。',
    },
    {
      key: 'serperApiKey',
      title: 'serperApiKey',
      description: 'Serper 搜索 API Key。配置后可供相关搜索工具使用。',
    },
  ];
}

export async function getMcpDetails(): Promise<ConfigWebMcpDetails> {
  if (!mcpInitialized) {
    mcpInitialized = true;
    await micaMcp.init().catch(() => undefined);
  }

  const configured = await micaMcp.loadConfig();
  const statuses = micaMcp.servers.get();
  const statusByName = new Map(statuses.map((status) => [status.name, status]));

  return {
    path: micaMcp.configPath,
    updatedAt: new Date().toISOString(),
    servers: Object.entries(configured).map(([name, config]) => {
      const status = statusByName.get(name);
      return {
        ...describeMcpConfig(name, config),
        status: status?.status ?? 'configured',
        toolCount: status?.toolCount ?? 0,
        tools: status?.tools ?? [],
        error: status?.error,
      } satisfies ConfigWebMcpServer;
    }),
  };
}

export function getSkillsDetails(): ConfigWebSkillsDetails {
  const root = getSkillsRootPath();
  const skills: Skill[] = existsSync(root) ? micaSkills.reload() : micaSkills.getLoaded();
  return {
    root,
    updatedAt: new Date().toISOString(),
    skills: skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      argumentHint: skill.argumentHint,
      baseDir: skill.baseDir,
      contentPreview: skill.content.trim().slice(0, 800),
    })),
  };
}

function describeMcpConfig(name: string, config: McpServerConfig): Omit<ConfigWebMcpServer, 'status' | 'toolCount' | 'tools'> {
  if ('url' in config) {
    return {
      name,
      type: 'http',
      target: config.url,
      configPath: micaMcp.configPath,
      envKeys: config.headers ? Object.keys(config.headers) : [],
    };
  }

  return {
    name,
    type: 'stdio',
    target: `${config.command} ${(config.args ?? []).join(' ')}`.trim(),
    configPath: micaMcp.configPath,
    cwd: config.cwd,
    envKeys: config.env ? Object.keys(config.env) : [],
  };
}

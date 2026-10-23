import { micaConfig } from '@packages/mica-config/index.js';
import { micaMcp } from '@packages/mica-mcp/index.js';
import { micaSkills } from '@packages/mica-skills/index.js';
import { micaTools } from '@packages/mica-tools/index.js';
import type { ConfigWebCapabilityDefaults } from '../shared/types.js';

/**
 * 新会话默认能力的唯一实现，CLI 配置页与桌面运行时共用。
 *
 * 目录来自当前进程的 skills / 工具注册表与 MCP 配置文件，开关来自 config.json 的
 * `capabilityDefaults`。已有会话的开关在各自的 snapshot 里，这里不会改写它们。
 */
export async function getCapabilityDefaultsDetails(): Promise<ConfigWebCapabilityDefaults> {
  const defaults = micaConfig.readCapabilityDefaults();
  const mcpConfig = await micaMcp.loadConfig().catch(() => ({}));
  return {
    skills: micaSkills
      .getLoaded()
      .map((skill) => ({ name: skill.name, description: skill.description }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    tools: micaTools
      .getCatalog()
      .filter((tool) => tool.source !== 'mcp')
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        readOnly: tool.readOnly,
        parameters: tool.parameters,
        group: tool.group,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    mcpServers: Object.keys(mcpConfig).sort((a, b) => a.localeCompare(b)),
    disabledSkills: defaults.disabledSkills,
    disabledTools: defaults.disabledTools,
    disabledMcpServers: defaults.disabledMcpServers,
  };
}

export async function writeCapabilityDefaults(input: {
  disabledSkills?: unknown;
  disabledTools?: unknown;
  disabledMcpServers?: unknown;
}): Promise<ConfigWebCapabilityDefaults> {
  micaConfig.updateCapabilityDefaults({
    version: 1,
    disabledSkills: normalizeNameList(input.disabledSkills),
    disabledTools: normalizeNameList(input.disabledTools),
    disabledMcpServers: normalizeNameList(input.disabledMcpServers),
  });
  return getCapabilityDefaultsDetails();
}

function normalizeNameList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0))];
}

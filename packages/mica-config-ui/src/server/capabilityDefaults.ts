import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { micaConfig } from '@packages/mica-config/index.js';
import { micaMcp } from '@packages/mica-mcp/index.js';
import { parsePluginManifest } from '@packages/mica-plugin/PluginManifest.js';
import { loadManifestSkills, readPublishedPluginSkills } from '@packages/mica-plugin/PluginSkills.js';
import { micaSkills } from '@packages/mica-skills/index.js';
import { micaTools } from '@packages/mica-tools/index.js';
import type { ConfigWebCapabilityDefaults } from '../shared/types.js';
import { getConfigRootPath } from './paths.js';
import { getPluginsDetails } from './plugins.js';

/**
 * 新会话默认能力的唯一实现，CLI 配置页与桌面运行时共用。
 *
 * 静态目录合并配置进程的 skills / 工具目录、插件技能索引与清单、MCP 配置文件；
 * 不 setup 插件，也不冒充会话的实际运行时。开关来自 config.json 的 `capabilityDefaults`，
 * 已有会话的开关在各自的 snapshot 里，这里不会改写它们。
 */
export async function getCapabilityDefaultsDetails(): Promise<ConfigWebCapabilityDefaults> {
  const defaults = micaConfig.readCapabilityDefaults();
  const mcpConfig = await micaMcp.loadConfig().catch(() => ({}));
  const { plugins } = getPluginsDetails();
  const pluginById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const skills: ConfigWebCapabilityDefaults['skills'] = micaSkills.getLoaded().map((skill) => ({
    name: skill.name,
    description: skill.description,
    path: join(skill.baseDir, 'SKILL.md'),
  }));
  const pluginSkills: ConfigWebCapabilityDefaults['skills'] = readPublishedPluginSkills({
    configDir: getConfigRootPath(),
  })
    .filter((skill) => {
      const plugin = pluginById.get(skill.pluginId);
      return plugin && plugin.state !== 'disabled';
    })
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      pluginId: skill.pluginId,
      path: skill.path,
    }));

  // 首次打开配置页时插件可能从未装配过；用户插件的清单技能不依赖发布索引。
  for (const plugin of plugins) {
    if (plugin.source !== 'user' || plugin.state === 'disabled') continue;
    try {
      const parsed = parsePluginManifest(JSON.parse(readFileSync(plugin.manifestFile, 'utf-8')));
      if (!parsed.ok) continue;
      for (const skill of loadManifestSkills(plugin.location, parsed.manifest.skills).skills) {
        pluginSkills.push({
          name: skill.name,
          description: skill.description,
          pluginId: plugin.id,
          path: join(skill.baseDir, 'SKILL.md'),
        });
      }
    } catch {
      // 清单损坏的原因已在插件目录里显示，不影响其余能力。
    }
  }

  // 同名磁盘技能优先；同路径则补上插件归属，避免已加载的插件技能被标为用户技能。
  const pluginByPath = new Map(pluginSkills.map((skill) => [skill.path, skill.pluginId]));
  for (const skill of skills) skill.pluginId = pluginByPath.get(skill.path);
  const byName = new Map<string, ConfigWebCapabilityDefaults['skills'][number]>();
  for (const skill of [...skills, ...pluginSkills]) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  return {
    skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    tools: micaTools
      .getCatalog()
      .filter((tool) => tool.source !== 'mcp')
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        readOnly: tool.readOnly,
        parameters: tool.parameters,
        group: tool.group,
        pluginId: tool.group?.key.startsWith('plugin:') ? tool.group.key.slice('plugin:'.length) : undefined,
        source: tool.source,
        inputSchema: tool.inputSchema,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    mcpServers: Object.keys(mcpConfig).sort((a, b) => a.localeCompare(b)),
    plugins: plugins.map(({ id, name, description, state, source, loadStatus, error }) => ({
      id,
      name,
      description,
      state,
      source,
      loadStatus,
      error,
    })),
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

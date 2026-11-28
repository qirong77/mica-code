import { isRecord } from '@packages/mica-common/guards.js';
import { readPromptControls, writePromptControls } from '@packages/mica-config/promptControls.js';
import { readConfigWebFile, writeConfigWebFile } from './configFiles.js';
import { runPluginAction as runPluginActionProcess } from './pluginAction.js';
import {
  createRole,
  createSkill,
  deleteRole,
  deleteSkill,
  getMcpDetails,
  getRolesDetails,
  getSkillsDetails,
  writeMcpServers,
  writeRole,
  writeSkill,
} from './details.js';
import { getCapabilityDefaultsDetails, writeCapabilityDefaults } from './capabilityDefaults.js';
import { testProviderConnection } from './providerTest.js';
import {
  setPluginEnabled as setPluginEnabledInStore,
  testPluginLlm as testPluginLlmInStore,
  setPluginSettings as setPluginSettingsInStore,
  getPluginsDetails,
} from './plugins.js';
import {
  getSessionContent,
  getSessionContextAnalysis,
  getSessionConversationPage,
  getSessionDetails,
  getSessionItem,
  getSessionsDetails,
  getSessionSystemPrompt,
  writeSessionDetails,
} from './sessions.js';

export type ConfigWebActionInput = {
  [key: string]: unknown;
};

type ConfigWebAction = (input: ConfigWebActionInput) => unknown;

/** Browser-host actions. Each handler selects and validates the fields used by its operation. */
export const configWebActions = {
  ping: (_input: ConfigWebActionInput) => ({ ok: true }),

  readConfigFile: (_input: ConfigWebActionInput) => readConfigWebFile(),
  writeConfigFile: (input: ConfigWebActionInput) => writeConfigWebFile(text(input, 'content')),
  // 服务商试连会真的发一次模型请求，所以参数只认表单上那四项，不带别的东西。
  testProvider: (input: ConfigWebActionInput) =>
    testProviderConnection({
      apiBase: text(input, 'apiBase'),
      apiKey: optionalText(input, 'apiKey'),
      protocol: optionalText(input, 'protocol'),
      model: text(input, 'model'),
    }),

  readMcpDetails: (_input: ConfigWebActionInput) => getMcpDetails(),
  writeMcpServers: (input: ConfigWebActionInput) => writeMcpServers(text(input, 'content')),

  readSkillsDetails: (_input: ConfigWebActionInput) => getSkillsDetails(),
  createSkill: (input: ConfigWebActionInput) => createSkill(text(input, 'name'), optionalText(input, 'content')),
  writeSkill: (input: ConfigWebActionInput) => writeSkill(text(input, 'name'), text(input, 'content')),
  deleteSkill: (input: ConfigWebActionInput) => deleteSkill(text(input, 'name')),

  readRolesDetails: (_input: ConfigWebActionInput) => getRolesDetails(),
  createRole: (input: ConfigWebActionInput) => createRole(text(input, 'name'), optionalText(input, 'content')),
  writeRole: (input: ConfigWebActionInput) => writeRole(text(input, 'name'), text(input, 'content')),
  deleteRole: (input: ConfigWebActionInput) => deleteRole(text(input, 'name')),

  readCapabilityDefaults: (_input: ConfigWebActionInput) => getCapabilityDefaultsDetails(),
  readPromptControls: (_input: ConfigWebActionInput) => readPromptControls(),
  writePromptControls: (input: ConfigWebActionInput) => {
    if (!isRecord(input.controls)) throw new Error('controls must be object');
    return writePromptControls(input.controls);
  },
  writeCapabilityDefaults: (input: ConfigWebActionInput) =>
    writeCapabilityDefaults({
      disabledSkills: input.disabledSkills,
      disabledTools: input.disabledTools,
      disabledMcpServers: input.disabledMcpServers,
    }),

  readPluginsDetails: (_input: ConfigWebActionInput) => getPluginsDetails(),
  setPluginEnabled: (input: ConfigWebActionInput) => setPluginEnabledInStore(text(input, 'id'), input.enabled === true),
  testPluginLlm: (input: ConfigWebActionInput) =>
    testPluginLlmInStore(text(input, 'id'), isRecord(input?.values) ? (input.values as Record<string, unknown>) : undefined),
  writePluginSettings: (input: ConfigWebActionInput) =>
    setPluginSettingsInStore(text(input, 'id'), record(input, 'values')),
  runPluginAction: (input: ConfigWebActionInput) =>
    runPluginActionProcess({
      id: text(input, 'id'),
      action: text(input, 'action'),
      cwd: optionalText(input, 'cwd') || undefined,
      values: optionalStringRecord(input.values),
    }),

  readSessionsDetails: (_input: ConfigWebActionInput) => getSessionsDetails(),
  readSessionDetails: (input: ConfigWebActionInput) => getSessionDetails(text(input, 'id')),
  readSessionContent: (input: ConfigWebActionInput) => getSessionContent(text(input, 'id')),
  readSessionConversationPage: (input: ConfigWebActionInput) =>
    getSessionConversationPage(
      text(input, 'id'),
      integer(input, 'offset', 0),
      integer(input, 'limit', 80),
      input.tail === true,
    ),
  readSessionItem: (input: ConfigWebActionInput) => getSessionItem(text(input, 'id'), integer(input, 'sequence', 1)),
  readSessionContextAnalysis: (input: ConfigWebActionInput) => getSessionContextAnalysis(text(input, 'id')),
  readSessionSystemPrompt: (input: ConfigWebActionInput) => getSessionSystemPrompt(text(input, 'id')),
  writeSession: (input: ConfigWebActionInput) => writeSessionDetails(text(input, 'id'), text(input, 'content')),
} satisfies Record<string, ConfigWebAction>;

export type ConfigWebActionName = keyof typeof configWebActions;

export const configWebActionNames = Object.keys(configWebActions) as ConfigWebActionName[];

export function isConfigWebActionName(value: unknown): value is ConfigWebActionName {
  return typeof value === 'string' && Object.hasOwn(configWebActions, value);
}

/** 传输层只负责搬运：动作名 + 参数进来，数据或错误出去。 */
export function runConfigWebAction(name: ConfigWebActionName, input: ConfigWebActionInput = {}): unknown {
  const action: ConfigWebAction = configWebActions[name];
  return action(input);
}

function text(input: ConfigWebActionInput, field: string): string {
  const value = input?.[field];
  if (typeof value !== 'string') throw new Error(`${field} must be string`);
  return value;
}

function optionalText(input: ConfigWebActionInput, field: string): string {
  const value = input?.[field];
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new Error(`${field} must be string`);
  return value;
}

/** 插件设置是一张表的键值对；不是对象就当空表，避免把半截数据写进设置文件。 */
function record(input: ConfigWebActionInput, field: string): Record<string, unknown> {
  const value = input?.[field];
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be object`);
  return value as Record<string, unknown>;
}

/** 插件动作的入参按「设置键 → 文本值」收窄：这些值会原样交给插件，形状必须确定。 */
function optionalStringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('values must be object');
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

function integer(input: ConfigWebActionInput, field: string, fallback: number): number {
  const value = Number(input?.[field]);
  if (!Number.isInteger(value) || value < 0) return fallback;
  return value;
}

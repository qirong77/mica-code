import { readConfigWebFile, writeConfigWebFile } from './configFiles.js';
import {
  createMcpServer,
  createRole,
  createSkill,
  deleteMcpServer,
  deleteRole,
  deleteSkill,
  getMcpDetails,
  getPluginsDetails,
  getRolesDetails,
  getSessionContent,
  getSessionContextAnalysis,
  getSessionConversationPage,
  getSessionDetails,
  getSessionItem,
  getSessionsDetails,
  getSkillsDetails,
  writeMcpServer,
  writeRole,
  writeSessionDetails,
  writeSkill,
} from './details.js';

export type ConfigWebActionInput = {
  [key: string]: unknown;
};

type ConfigWebAction = (input: ConfigWebActionInput) => unknown;

/**
 * 配置页的全部数据操作。
 *
 * 页面本身不关心数据从哪来：浏览器里是 HTTP（apps/config-web 的 server.ts），桌面端是
 * 运行时的 IPC（apps/desktop 的 host/configWeb.js），两条传输层都收敛到这一张表，所以
 * 参数校验、错误语义、返回值只在这里定义一次。
 */
export const configWebActions = {
  ping: (_input: ConfigWebActionInput) => ({ ok: true }),

  readConfigFile: (_input: ConfigWebActionInput) => readConfigWebFile(),
  writeConfigFile: (input: ConfigWebActionInput) => writeConfigWebFile(text(input, 'content')),

  readMcpDetails: (_input: ConfigWebActionInput) => getMcpDetails(),
  createMcpServer: (input: ConfigWebActionInput) =>
    createMcpServer(text(input, 'name'), optionalText(input, 'content')),
  writeMcpServer: (input: ConfigWebActionInput) =>
    writeMcpServer(text(input, 'name'), text(input, 'content')),
  deleteMcpServer: (input: ConfigWebActionInput) => deleteMcpServer(text(input, 'name')),

  readSkillsDetails: (_input: ConfigWebActionInput) => getSkillsDetails(),
  createSkill: (input: ConfigWebActionInput) =>
    createSkill(text(input, 'name'), optionalText(input, 'content')),
  writeSkill: (input: ConfigWebActionInput) =>
    writeSkill(text(input, 'name'), text(input, 'content')),
  deleteSkill: (input: ConfigWebActionInput) => deleteSkill(text(input, 'name')),

  readRolesDetails: (_input: ConfigWebActionInput) => getRolesDetails(),
  createRole: (input: ConfigWebActionInput) =>
    createRole(text(input, 'name'), optionalText(input, 'content')),
  writeRole: (input: ConfigWebActionInput) => writeRole(text(input, 'name'), text(input, 'content')),
  deleteRole: (input: ConfigWebActionInput) => deleteRole(text(input, 'name')),

  readPluginsDetails: (_input: ConfigWebActionInput) => getPluginsDetails(),

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
  readSessionItem: (input: ConfigWebActionInput) =>
    getSessionItem(text(input, 'id'), integer(input, 'sequence', 1)),
  readSessionContextAnalysis: (input: ConfigWebActionInput) =>
    getSessionContextAnalysis(text(input, 'id')),
  writeSession: (input: ConfigWebActionInput) =>
    writeSessionDetails(text(input, 'id'), text(input, 'content')),
} satisfies Record<string, ConfigWebAction>;

export type ConfigWebActionName = keyof typeof configWebActions;

export const configWebActionNames = Object.keys(configWebActions) as ConfigWebActionName[];

export function isConfigWebActionName(value: unknown): value is ConfigWebActionName {
  return typeof value === 'string' && Object.hasOwn(configWebActions, value);
}

/** 传输层只负责搬运：动作名 + 参数进来，数据或错误出去。 */
export function runConfigWebAction(
  name: ConfigWebActionName,
  input: ConfigWebActionInput = {},
): unknown {
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

function integer(input: ConfigWebActionInput, field: string, fallback: number): number {
  const value = Number(input?.[field]);
  if (!Number.isInteger(value) || value < 0) return fallback;
  return value;
}

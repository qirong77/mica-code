import type { ConfigWebActionName } from '../src/server/actions.js';
import type { ConfigWebClient } from './api.js';

type ClientAction = Exclude<ConfigWebActionName, 'ping'>;
type DataClient = Required<Pick<ConfigWebClient, ClientAction>>;
type Invoke = <K extends ClientAction>(
  action: K,
  input?: Record<string, unknown>,
) => Promise<Awaited<ReturnType<DataClient[K]>>>;

/** Both transports take named fields. Page components use the same typed methods on either host. */
export function createConfigDataClient(invoke: Invoke): DataClient {
  return {
    readConfigFile: () => invoke('readConfigFile'),
    writeConfigFile: (content) => invoke('writeConfigFile', { content }),
    testProvider: (input) => invoke('testProvider', input),
    readMcpDetails: () => invoke('readMcpDetails'),
    writeMcpServers: (content) => invoke('writeMcpServers', { content }),
    readCapabilityDefaults: () => invoke('readCapabilityDefaults'),
    writeCapabilityDefaults: (input) => invoke('writeCapabilityDefaults', input),
    readPromptControls: () => invoke('readPromptControls'),
    writePromptControls: (controls) => invoke('writePromptControls', { controls }),
    readSkillsDetails: () => invoke('readSkillsDetails'),
    createSkill: (name, content = '') => invoke('createSkill', { name, content }),
    writeSkill: (name, content) => invoke('writeSkill', { name, content }),
    deleteSkill: (name) => invoke('deleteSkill', { name }),
    readRolesDetails: () => invoke('readRolesDetails'),
    createRole: (name, content = '') => invoke('createRole', { name, content }),
    writeRole: (name, content) => invoke('writeRole', { name, content }),
    deleteRole: (name) => invoke('deleteRole', { name }),
    readPluginsDetails: () => invoke('readPluginsDetails'),
    setPluginEnabled: (id, enabled) => invoke('setPluginEnabled', { id, enabled }),
    writePluginSettings: (id, values) => invoke('writePluginSettings', { id, values }),
    testPluginLlm: (id, values) => invoke('testPluginLlm', { id, values }),
    runPluginAction: (id, action, values, cwd) => invoke('runPluginAction', { id, action, values, cwd }),
    readSessionsDetails: () => invoke('readSessionsDetails'),
    readSessionDetails: (id) => invoke('readSessionDetails', { id }),
    readSessionContent: (id) => invoke('readSessionContent', { id }),
    readSessionConversationPage: (id, offset, limit, tail = false) =>
      invoke('readSessionConversationPage', { id, offset, limit, tail }),
    readSessionItem: (id, sequence) => invoke('readSessionItem', { id, sequence }),
    readSessionContextAnalysis: (id) => invoke('readSessionContextAnalysis', { id }),
    readSessionSystemPrompt: (id) => invoke('readSessionSystemPrompt', { id }),
    writeSession: (id, content) => invoke('writeSession', { id, content }),
  };
}

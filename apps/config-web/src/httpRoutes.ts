import type { ConfigWebActionName } from '@packages/mica-config-ui/src/server/actions.js';

export const CONFIG_WEB_EVENTS_PATH = '/api/events';
type HttpRoute = { method: 'GET' | 'PUT' | 'POST' | 'DELETE'; path: string; view?: string };
const sessionPath = '/api/details/session';

export const httpRoutes: Record<ConfigWebActionName, HttpRoute> = {
  ping: { method: 'GET', path: '/api/ping' },
  readConfigFile: { method: 'GET', path: '/api/files/config' },
  writeConfigFile: { method: 'PUT', path: '/api/files/config' },
  testProvider: { method: 'POST', path: '/api/provider-test' },
  readMcpDetails: { method: 'GET', path: '/api/details/mcp' },
  writeMcpServers: { method: 'PUT', path: '/api/details/mcp' },
  readCapabilityDefaults: { method: 'GET', path: '/api/details/capabilities' },
  writeCapabilityDefaults: { method: 'PUT', path: '/api/details/capabilities' },
  readPromptControls: { method: 'GET', path: '/api/details/prompt-controls' },
  writePromptControls: { method: 'PUT', path: '/api/details/prompt-controls' },
  readSkillsDetails: { method: 'GET', path: '/api/details/skills' },
  createSkill: { method: 'POST', path: '/api/files/skill' },
  writeSkill: { method: 'PUT', path: '/api/files/skill' },
  deleteSkill: { method: 'DELETE', path: '/api/files/skill' },
  readRolesDetails: { method: 'GET', path: '/api/details/roles' },
  createRole: { method: 'POST', path: '/api/files/role' },
  writeRole: { method: 'PUT', path: '/api/files/role' },
  deleteRole: { method: 'DELETE', path: '/api/files/role' },
  readPluginsDetails: { method: 'GET', path: '/api/details/plugins' },
  setPluginEnabled: { method: 'PUT', path: '/api/details/plugins' },
  writePluginSettings: { method: 'PUT', path: '/api/details/plugin-settings' },
  testPluginLlm: { method: 'POST', path: '/api/details/plugin-llm-test' },
  runPluginAction: { method: 'POST', path: '/api/details/plugin-action' },
  readSessionsDetails: { method: 'GET', path: '/api/details/sessions' },
  readSessionDetails: { method: 'GET', path: sessionPath },
  readSessionContent: { method: 'GET', path: sessionPath, view: 'json' },
  readSessionConversationPage: { method: 'GET', path: sessionPath, view: 'conversation' },
  readSessionItem: { method: 'GET', path: sessionPath, view: 'item' },
  readSessionContextAnalysis: { method: 'GET', path: sessionPath, view: 'context' },
  readSessionSystemPrompt: { method: 'GET', path: sessionPath, view: 'prompt' },
  writeSession: { method: 'PUT', path: '/api/files/session' },
};

const actions = Object.keys(httpRoutes) as ConfigWebActionName[];

export function matchHttpAction(path: string, method: string, view?: string): ConfigWebActionName | 404 | 405 {
  const candidates = actions.filter((name) => httpRoutes[name].path === path);
  if (!candidates.length) return 404;
  const allowed = candidates.filter((name) => httpRoutes[name].method === method);
  return (
    allowed.find((name) => httpRoutes[name].view === view) ??
    allowed.find((name) => httpRoutes[name].view === undefined) ??
    405
  );
}

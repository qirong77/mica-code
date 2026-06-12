import { agentTurn } from '../agent/turn.js';
import { ui } from '../components/index.js';
import { messagesAtom } from '../store/conversation.js';
import { model, api } from '../store/config.js';
import {
  session,
  thinkingTextAtom,
  responseTextAtom,
  quickCommandsAtom,
} from '../store/ui-state.js';
import { sessionToolRecordsAtom } from '../store/logAtom.js';
import { MicaPlugin } from '../plugins/MicaPlugin.js';
import { bootstrap } from '../bootstrap.js';
import { initMcp } from '../mcp/index.js';
bootstrap();

const _plugins: MicaPlugin[] = [];

session.switchSignal.listen((newSessionId) => {
  if (!newSessionId) return;
  const oldId = session.currentId.get();
  for (const plugin of _plugins) {
    plugin.onSessionSwitch(newSessionId, oldId);
    plugin.reset();
  }
});

export const MicaAgent = {
  agentTurn,
  ui,
  usePlugin: async (plugin: MicaPlugin) => {
    plugin.agent = MicaAgent;
    plugin.atoms = {
      messages: messagesAtom,
      model: model.name,
      effort: model.effort,
      modelOptions: model.options,
      effortOptions: model.effortOptions,
      sessionsIndex: session.index,
      currentSessionId: session.currentId,
      sessionSwitch: session.switchSignal,
      thinkingText: thinkingTextAtom,
      responseText: responseTextAtom,
      sessionToolRecords: sessionToolRecordsAtom,
      maxTokens: model.maxTokens,
      contextWindowSize: model.contextWindowSize,
      apiBaseUrl: api.baseUrl,
      apiKey: api.apiKey,
      quickCommands: quickCommandsAtom,
    };
    _plugins.push(plugin);
    await plugin.onInstall();
    plugin._installed = true;
    return plugin;
  },
  run() {
    initMcp().catch((err) => {
      console.error('MCP 初始化失败:', err);
    });
    ui.run();
  },
};
export type IMicaAgent = typeof MicaAgent;

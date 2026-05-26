import { agentTurn } from '../agent/turn.js';
import { ui } from '../components/ui/index.js';
import { messagesAtom } from '../store/conversation.js';
import { model, api } from '../store/config.js';
import { session, logTextAtom, systemLogVisibleAtom, quickCommandsAtom } from '../store/ui-state.js';
import { sessionToolRecordsAtom } from '../store/logAtom.js';
import { MicaPlugin } from '../plugins/MicaPlugin.js';
import { bootstrap } from '../bootstrap.js';
import './effect.js';
bootstrap();

const _installedPlugins: MicaPlugin[] = [];

export const MicaAgent = {
  agentTurn,
  ui,
  usePlugin: async (plugin: MicaPlugin) => {
    plugin.agent = MicaAgent;
    plugin.atoms = {
      messages: messagesAtom,
      model: model.atom,
      effort: model.effort,
      modelOptions: model.options,
      effortOptions: model.effortOptions,
      sessionsIndex: session.index,
      currentSessionId: session.currentId,
      sessionSwitch: session.switch,
      logText: logTextAtom,
      sessionToolRecords: sessionToolRecordsAtom,
      systemLogVisible: systemLogVisibleAtom,
      maxTokens: model.maxTokens,
      contextWindowSize: model.conextWindowSize,
      apiBaseUrl: api.baseUrl,
      apiKey: api.apiKey,
      quickCommands: quickCommandsAtom,
    };
    await plugin.onInstall();
    _installedPlugins.push(plugin);
    return plugin;
  },
  run() {
    ui.run();
  },
};
export type IMicaAgent = typeof MicaAgent;

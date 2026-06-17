import { themeColors } from './theme.js';
import * as conv from './conversation/state.js';
import * as input from './input/state.js';
import * as dropdown from './bottom/dropdown/state.js';
import * as panels from './panels/state.js';
import { pushLog, clearLog, setOnAbortAgent, abortAgent } from './panels/state.js';
import { MessageBarAPI } from './panels/MessageBar.js';
import { DropDownUI } from './bottom/dropdown/index.js';
import { TerminalInputUI } from './input/TerminalInput.js';

export const micaUI = {
  conversation: conv,
  terminalInput: {
    ...input,
    onSubmit: input.onSubmit,
    offSubmit: input.offSubmit,
    submit: input.submit,
  },
  dropdown: {
    ...dropdown,
    onSelect: DropDownUI.onSelect,
    quickCommand: DropDownUI.quickCommand,
  },
  bottom: {
    dropdown: {
      ...dropdown,
      onSelect: DropDownUI.onSelect,
      quickCommand: DropDownUI.quickCommand,
    },
    agentTurnLog: {
      items: panels.agentTurnLogItems,
      setItems: panels.setAgentTurnLogItems,
      appendItem: panels.appendAgentTurnLogItem,
      replaceItem: panels.replaceAgentTurnLogItem,
      clear: panels.clearAgentTurnLogItems,
    },
    plugins: {
      items: panels.pluginUIs,
      setItems: panels.setPluginUIs,
      clear: panels.clearPluginUIs,
    },
  },
  panels: {
    ...panels,
    pushLog,
    clearLog,
    setOnAbortAgent,
    abortAgent,
  },
  messageBar: MessageBarAPI,
  theme: { colors: themeColors },
};

export { App } from './app/App.js';
export { Conversation, ConversationUI } from './conversation/Conversation.js';
export { Markdown } from './conversation/Markdown.js';
export { TerminalInputUI } from './input/TerminalInput.js';
export { WorkingStatus, WorkingStatusUI } from './panels/WorkingStatus.js';
export { LogView } from './panels/LogView.js';
export { AgentTurnLog, AgentTurnLogUI } from './bottom/AgentTurnLog.js';
export { MessageBar, MessageBarAPI } from './panels/MessageBar.js';
export { PluginPanel } from './bottom/PluginPanel.js';
export { BottomSurface, BottomSurfaceUI } from './bottom/BottomSurface.js';
export { DropDownUI } from './bottom/dropdown/index.js';
export { useScheduleState } from './hooks/index.js';
export { useLogViewHeight } from './hooks/useLogViewHeight.js';
export { parseImageRefs } from './utils/imagePaste.js';
export { themeColors, C } from './theme.js';

export type {
  MicaUiWorkingStatus,
  MicaUiLogEntry,
  MicaUiThinkingEntry,
  MicaUiToolEntry,
  MicaUiDropdownItem,
  MicaUiDropdownState,
  MicaUiPluginUI,
  MicaUiCommand,
  MicaUiConversationMessage,
  MicaUiUILogEntry,
  MicaUiTextBlock,
  MicaUiImageBlockParam,
  MicaUiContentBlockParam,
  MicaUiMessageParam,
  MicaUiAgentTurnLogItem,
} from './types.js';

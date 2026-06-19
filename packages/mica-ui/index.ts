import { themeColors, C } from './theme.js';
import * as conv from './conversation/state.js';
import * as input from './input/state.js';
import * as dropdown from './bottom/dropdown/state.js';
import * as panels from './panels/state.js';
import { pushLog, clearLog, setOnAbortAgent, abortAgent } from './panels/state.js';
import { MessageBar, MessageBarAPI } from './panels/MessageBar.js';
import { DropDownUI } from './bottom/dropdown/index.js';
import { TerminalInputUI } from './input/TerminalInput.js';
import { App } from './app/App.js';
import { Conversation, ConversationUI } from './conversation/Conversation.js';
import { Markdown } from './conversation/Markdown.js';
import { WorkingStatus, WorkingStatusUI } from './panels/WorkingStatus.js';
import { LogView } from './panels/LogView.js';
import { AgentTurnLog, AgentTurnLogUI } from './bottom/AgentTurnLog.js';
import { PluginPanel } from './bottom/PluginPanel.js';
import { BottomSurface, BottomSurfaceUI } from './bottom/BottomSurface.js';
import { useScheduleState } from './hooks/index.js';
import { useLogViewHeight } from './hooks/useLogViewHeight.js';
import { Dialog, KeyHints, SelectList, Spin, useSpinner } from './primitives/index.js';
import { parseImageRefs } from './utils/imagePaste.js';

export const micaUI = {
  App,
  Conversation,
  ConversationUI,
  Markdown,
  TerminalInputUI,
  WorkingStatus,
  WorkingStatusUI,
  LogView,
  AgentTurnLog,
  AgentTurnLogUI,
  MessageBar,
  PluginPanel,
  BottomSurface,
  BottomSurfaceUI,
  DropDownUI,
  useScheduleState,
  useLogViewHeight,
  Dialog,
  KeyHints,
  SelectList,
  Spin,
  useSpinner,
  parseImageRefs,
  C,
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

export type { SelectItem } from './primitives/index.js';
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

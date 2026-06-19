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
  /** 订阅 nanostores 状态并让 Ink 组件按节流节奏刷新。 */
  useScheduleState,
  /** 根据终端尺寸和底部面板状态计算日志视图高度。 */
  useLogViewHeight,
  Dialog,
  KeyHints,
  SelectList,
  Spin,
  useSpinner,
  /** 从用户输入文本中提取图片引用并转换成 agent 可消费的内容块。 */
  parseImageRefs,
  C,
  conversation: conv,
  terminalInput: {
    ...input,
    /** 注册终端输入提交监听器。 */
    onSubmit: input.onSubmit,
    /** 取消注册终端输入提交监听器。 */
    offSubmit: input.offSubmit,
    /** 触发一次终端输入提交。 */
    submit: input.submit,
  },
  dropdown: {
    ...dropdown,
    /** 注册下拉菜单选中项监听器。 */
    onSelect: DropDownUI.onSelect,
    /** 用当前输入内容打开快捷命令下拉菜单。 */
    quickCommand: DropDownUI.quickCommand,
  },
  bottom: {
    dropdown: {
      ...dropdown,
      /** 注册底部下拉菜单选中项监听器。 */
      onSelect: DropDownUI.onSelect,
      /** 用当前输入内容打开底部快捷命令下拉菜单。 */
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
    /** 在运行日志面板追加一条日志。 */
    pushLog,
    /** 清空运行日志面板内容。 */
    clearLog,
    /** 设置用户触发 abort 时调用的 agent 中断回调。 */
    setOnAbortAgent,
    /** 触发当前 agent 任务中断。 */
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

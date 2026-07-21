import { themeColors } from './theme.js';
import * as conv from './conversation/state.js';
import * as input from './input/state.js';
import * as dropdown from './bottom/dropdown/state.js';
import * as panels from './panels/state.js';
import { setOnAbortAgent, abortAgent, setOnEditPendingInput, editPendingInput } from './panels/state.js';
import { MessageBar, MessageBarAPI } from './panels/MessageBar.js';
import { DropDownUI } from './bottom/dropdown/index.js';
import { TerminalInputUI } from './input/TerminalInput.js';
import { App } from './app/App.js';
import { StartupBanner, StartupBannerUI } from './app/StartupBanner.js';
import { Conversation, ConversationUI } from './conversation/Conversation.js';
import { Markdown } from './conversation/Markdown.js';
import { WorkingStatus, WorkingStatusUI } from './panels/WorkingStatus.js';
import { TaskStatusBar, TaskStatusBarUI } from './panels/TaskStatusBar.js';
import { CommandPanel, CommandPanelUI } from './panels/CommandPanel.js';
import { AgentTurnLog, AgentTurnLogUI } from './bottom/AgentTurnLog.js';
import { BottomSurface, BottomSurfaceUI } from './bottom/BottomSurface.js';
import { useScheduleState } from './hooks/index.js';
import { useLogViewHeight } from './hooks/useLogViewHeight.js';
import {
  BottomScrollBox,
  Dialog,
  KeyHints,
  MessageGutter,
  MessageResponse,
  OneLineItem,
  SelectList,
  Spin,
  getOneLineColumnWidth,
  useSpinner,
} from './primitives/index.js';
import { parseImageRefs } from './utils/imagePaste.js';
import { createThinkingLogItem, createToolCallLogItem } from './agentTurnLogItems.js';

export const micaUi = {
  App,
  StartupBanner,
  StartupBannerUI,
  Conversation,
  ConversationUI,
  Markdown,
  TerminalInputUI,
  WorkingStatus,
  WorkingStatusUI,
  TaskStatusBar,
  TaskStatusBarUI,
  CommandPanel,
  CommandPanelUI,
  AgentTurnLog,
  AgentTurnLogUI,
  MessageBar,
  BottomSurface,
  BottomSurfaceUI,
  DropDownUI,
  /** 订阅 nanostores 状态并让 Ink 组件按节流节奏刷新。 */
  useScheduleState,
  /** 根据终端尺寸和底部面板状态计算日志视图高度。 */
  useLogViewHeight,
  BottomScrollBox,
  Dialog,
  KeyHints,
  MessageGutter,
  MessageResponse,
  SelectList,
  OneLineItem,
  getOneLineColumnWidth,
  Spin,
  useSpinner,
  /** 从用户输入文本中提取图片引用并转换成 agent 可消费的内容块。 */
  parseImageRefs,
  /** 创建 agent thinking 流式日志 UI item。 */
  createThinkingLogItem,
  /** 创建 agent 工具调用日志 UI item。 */
  createToolCallLogItem,
  conversation: conv,
  terminalInput: {
    ...input,
    /** 注册终端输入提交监听器。 */
    onSubmit: input.onSubmit,
    /** 取消注册终端输入提交监听器。 */
    offSubmit: input.offSubmit,
    /** 触发一次终端输入提交。 */
    submit: input.submit,
    /** 设置 Shift+Tab 切换 role 的回调。 */
    setOnCycleRole: input.setOnCycleRole,
    /** 触发一次 role 循环切换。 */
    cycleRole: input.cycleRole,
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
    /** 设置用户触发 abort 时调用的 agent 中断回调。 */
    setOnAbortAgent,
    /** 触发当前 agent 任务中断。 */
    abortAgent,
    /** 设置用户重新编辑 pending 输入时调用的回调。 */
    setOnEditPendingInput,
    /** 取回一条 pending 输入用于重新编辑。 */
    editPendingInput,
  },
  messageBar: MessageBarAPI,
  theme: { colors: themeColors },
};

export type {
  MessageGutterProps,
  MessageGutterTone,
  OneLineItemCell,
  SelectItem,
  SelectListLayout,
  BottomScrollBoxProps,
} from './primitives/index.js';
export type { MessageItem } from './panels/MessageBar.js';
export type { MicaUiPendingInputQueueMode } from './conversation/state.js';
export type { TerminalFileMentionItem, TerminalFileMentionProvider } from './input/state.js';
export type {
  MicaUiWorkingStatus,
  MicaUiDropdownItem,
  MicaUiDropdownState,
  MicaUiPluginUI,
  MicaUiPluginStatusItem,
  MicaUiCommand,
  MicaUiBackgroundTaskItem,
  MicaUiBackgroundTaskStatus,
  MicaUiSubagentTaskItem,
  MicaUiSubagentTaskStatus,
  MicaUiCommandCompletionItem,
  MicaUiCommandCompletionItems,
  MicaUiConversationMessage,
  MicaUiTextBlock,
  MicaUiImageBlockParam,
  MicaUiContentBlockParam,
  MicaUiMessageParam,
  MicaUiAgentTurnLogItem,
  MicaUiCommandPanelItem,
  MicaUiCommandPanelStatus,
  MicaUiCommandStatus,
  MicaUiCommandPanelVariant,
  MicaUiAgentStatusItem,
  MicaUiStartupBannerState,
} from './types.js';

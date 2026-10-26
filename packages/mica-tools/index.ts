import { MicaTool } from './MicaTool.js';
import {
  registerMcpTools,
  unregisterMcpTools,
  registerRuntimeTool,
  unregisterRuntimeTool,
  unregisterRuntimeTools,
  getToolDefinitions,
  getToolCounts,
  getToolCatalog,
  executeTool,
  getToolDisplayText,
  isToolReadOnly,
  isToolOverlappable,
  isToolPrimaryAgentOnly,
  observeToolExecution,
} from './registry.js';
import { mcpToolNamePrefix, sanitizeToolNamePart } from './toolNames.js';

export const micaTools = {
  /** 将 MCP server 暴露的工具注册进统一工具 registry。 */
  registerMcp: registerMcpTools,
  /** 移除指定 MCP server 已注册的工具。 */
  unregisterMcp: unregisterMcpTools,
  /** 注册运行时工具，例如依赖应用上下文的 Agent 工具。 */
  registerRuntime: registerRuntimeTool,
  /** 移除指定运行时工具。 */
  unregisterRuntime: unregisterRuntimeTool,
  /** 移除所有运行时工具。 */
  unregisterAllRuntime: unregisterRuntimeTools,
  /** 获取当前可提供给模型的工具定义列表。 */
  getDefinitions: getToolDefinitions,
  /** 获取当前工具数量统计。 */
  getCounts: getToolCounts,
  /** 获取完整工具目录（含来源与所属 MCP server），供能力选择面板使用。 */
  getCatalog: getToolCatalog,
  /** 按工具名执行工具，并返回序列化后的执行结果。 */
  execute: executeTool,
  /** 获取工具调用在 UI 日志中的展示文本。 */
  getDisplayText: getToolDisplayText,
  /** 判断工具是否声明为只读。 */
  isReadOnly: isToolReadOnly,
  /** 按工具及输入判断调用是否可与同一条消息里其余调用重叠执行。 */
  isOverlappable: isToolOverlappable,
  /** 判断工具是否只允许顶层 agent 使用。 */
  isPrimaryAgentOnly: isToolPrimaryAgentOnly,
  /** 观察所有工具执行，用于审计、变更追踪等横切能力。 */
  observeExecution: observeToolExecution,
  sanitizeToolNamePart,
  mcpToolNamePrefix,
  MicaTool,
};

export { MicaTool } from './MicaTool.js';
export { ToolRunShell } from './ToolRunShell.js';
export { ToolBackgroundStart } from './ToolBackgroundStart.js';
export { ToolBackgroundRead } from './ToolBackgroundRead.js';
export { ToolWaitFor } from './ToolWaitFor.js';
export { ToolPtySpawn } from './pty/ToolPtySpawn.js';
export { ToolPtySend } from './pty/ToolPtySend.js';
export { ToolPtyRead } from './pty/ToolPtyRead.js';
export { ToolPtyWait } from './pty/ToolPtyWait.js';
export { ToolPtyKill } from './pty/ToolPtyKill.js';
export type { ToolExecuteCallbacks, ToolInput } from './MicaTool.js';
export type { ToolSafetyOptions, ToolScheduleOptions } from './MicaTool.js';
export type { RuntimeToolRegistrationOptions, ToolFilter } from './registry.js';
export type { ToolCatalogEntry, ToolGroupEntry, ToolParameterEntry } from './registry.js';
export type { ToolExecutionEvent, ToolExecutionObserver } from './registry.js';
export { toolResultToText } from './types.js';
export { mcpToolNamePrefix, sanitizeToolNamePart } from './toolNames.js';
export type {
  Tool,
  ToolImageMediaType,
  ToolResult,
  ToolResultBlock,
  ToolResultImageBlock,
  ToolResultTextBlock,
} from './types.js';
export {
  cleanBackgroundTaskOutput,
  getBackgroundTaskOutputSize,
  listBackgroundTasks,
  loadBackgroundTask,
  readBackgroundTaskOutput,
  killBackgroundTask,
  terminateCurrentBackgroundTasks,
} from './ToolRunShellBackground.js';
export type { BackgroundTaskMeta, BackgroundTaskStatus } from './ToolRunShellBackground.js';
export {
  listActiveWaits,
  listWaitRecords,
  clearWaitRecords,
  isActiveWaitStatus,
} from './waitFor/registry.js';
export type { WaitRecord, WaitTaskStatus } from './waitFor/registry.js';
export type { NormalizedWaitCondition, WaitKind } from './waitFor/types.js';

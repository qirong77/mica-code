import { MicaTool } from './MicaTool.js';
import {
  registerMcpTools,
  unregisterMcpTools,
  registerRuntimeTool,
  unregisterRuntimeTool,
  unregisterRuntimeTools,
  getToolDefinitions,
  getToolCounts,
  executeTool,
  getToolDisplayText,
  isToolReadOnly,
} from './registry.js';

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
  /** 按工具名执行工具，并返回序列化后的执行结果。 */
  execute: executeTool,
  /** 获取工具调用在 UI 日志中的展示文本。 */
  getDisplayText: getToolDisplayText,
  /** 判断工具是否声明为只读。 */
  isReadOnly: isToolReadOnly,
  MicaTool,
};

export { MicaTool } from './MicaTool.js';
export type { ToolExecuteCallbacks, ToolInput } from './MicaTool.js';
export type { ToolFilter } from './registry.js';
export type { Tool } from './types.js';
export {
  getBackgroundTaskOutputSize,
  listBackgroundTasks,
  readBackgroundTaskOutput,
  terminateCurrentBackgroundTasks,
} from './ToolRunShellBackground.js';
export type { BackgroundTaskMeta, BackgroundTaskStatus } from './ToolRunShellBackground.js';

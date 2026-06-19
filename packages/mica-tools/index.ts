import { MicaTool } from './MicaTool.js';
import {
  registerMcpTools,
  unregisterMcpTools,
  getToolDefinitions,
  executeTool,
  getToolDisplayText,
} from './registry.js';

export const micaTools = {
  registerMcp: registerMcpTools,
  unregisterMcp: unregisterMcpTools,
  getDefinitions: getToolDefinitions,
  execute: executeTool,
  getDisplayText: getToolDisplayText,
  MicaTool,
};

export type { MicaTool, ToolExecuteCallbacks } from './MicaTool.js';
export type { Tool } from './types.js';

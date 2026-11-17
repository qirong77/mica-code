import {
  observePluginOperation, startPluginOperation, type OperationContext, type OperationOutcome,
} from '@packages/mica-diagnostics/operation.js';
import { MicaTool, createPluginTool, type PluginToolDescriptor, type ToolExecuteCallbacks, type ToolInput } from '@packages/mica-tools/index.js';

/** Fixed identifiers only: never use a command, document name, path or URL as an operation. */
export type PluginOperations = {
  run<T>(operation: string, task: () => T | Promise<T>, options?: { signal?: AbortSignal }): Promise<T>;
};

export function createPluginOperations(plugin: string, pluginVersion?: string): PluginOperations {
  return { run: (operation, task, options) => observePluginOperation({ plugin, pluginVersion, operation, ...options }, task) };
}

/** Preserve synchronous hooks and public return types; observers cannot change scheduling. */
export function observePluginHandler<T>(context: OperationContext, task: () => T): T {
  const span = startPluginOperation(context);
  try {
    const value = task();
    if (value && typeof (value as { then?: unknown }).then === 'function') {
      return Promise.resolve(value).then(
        (result) => { span.finish(result); return result; },
        (error: unknown) => { span.finish(undefined, { error }); throw error; },
      ) as T;
    }
    span.finish(value);
    return value;
  } catch (error) {
    span.finish(undefined, { error });
    throw error;
  }
}

/** A proxy leaves registered instances and their private state untouched. */
export function observePluginTool(inputTool: MicaTool | PluginToolDescriptor, context: Omit<OperationContext, 'operation' | 'surface'>): MicaTool {
  const tool = typeof (inputTool as MicaTool).executeTimed === 'function' ? inputTool as MicaTool : createPluginTool(inputTool as PluginToolDescriptor);
  return new Proxy(tool, {
    get(target, key, receiver) {
      if (key === 'execute') return (input: ToolInput, callbacks?: ToolExecuteCallbacks) => observePluginHandler(
        { ...context, operation: 'tool.execute', surface: 'tool', signal: callbacks?.signal },
        () => target.execute(input, callbacks),
      );
      if (key === 'executeTimed') return MicaTool.prototype.executeTimed.bind(receiver);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export const skippedOperation = (): OperationOutcome => ({ outcome: 'skipped', code: 'unavailable' });

import { MicaTool } from './MicaTool.js';
import type { ToolExecuteCallbacks, ToolInputSchema, ToolInput } from './MicaTool.js';
import type { ToolResult } from './types.js';

/**
 * 用**纯数据**描述一个工具。
 *
 * 随包插件能 `import { MicaTool }` 并继承，但用户插件（`$MICA_HOME/plugins` 下的普通
 * JS）没有仓库里的模块可导入——它们只能拿到宿主注入的 `ctx`。所以插件注册工具时允许
 * 直接给这份描述：宿主用 `createPluginTool` 换成真正的 `MicaTool`，校验、超时包装、
 * 错误格式化、展示文案的默认实现都由基类提供。
 */
export type PluginToolDescriptor = {
  /** 工具名，一律 snake_case，和内置工具同名会覆盖内置的。 */
  name: string;
  description: string;
  input_schema: ToolInputSchema;
  /** 只读的查询工具设 true；有写副作用的（改会话状态、文件、外部服务）必须留空。 */
  readOnly?: boolean;
  /** 纯等待类工具（见 `ToolScheduleOptions.overlappable`）。 */
  overlappable?: boolean;
  execute(input: ToolInput, callbacks?: ToolExecuteCallbacks): Promise<ToolResult> | ToolResult;
  /** 工具行那一行字；不给就用工具名。 */
  displayText?(input: ToolInput): string;
};

/** 把插件给的描述包成 `MicaTool`：插件不必了解基类，也不必自己实现校验与超时包装。 */
export function createPluginTool(descriptor: PluginToolDescriptor): MicaTool {
  if (!descriptor || typeof descriptor.name !== 'string' || !descriptor.name.trim()) {
    throw new Error('插件工具缺少 name');
  }
  if (typeof descriptor.execute !== 'function') {
    throw new Error(`插件工具 ${descriptor.name} 缺少 execute`);
  }
  return new DescriptorTool(descriptor);
}

class DescriptorTool extends MicaTool {
  private readonly descriptor: PluginToolDescriptor;

  constructor(descriptor: PluginToolDescriptor) {
    super(descriptor.name, descriptor.description ?? '', descriptor.input_schema ?? { type: 'object' }, {
      readOnly: descriptor.readOnly ?? false,
      overlappable: descriptor.overlappable ?? false,
    });
    this.descriptor = descriptor;
  }

  execute(input: ToolInput, callbacks?: ToolExecuteCallbacks): Promise<ToolResult> {
    return Promise.resolve(this.descriptor.execute(input, callbacks));
  }

  onToolUseDisplayText(input: ToolInput): string {
    if (!this.descriptor.displayText) return this.name;
    try {
      return this.descriptor.displayText(input);
    } catch {
      // 展示文案出错不该让工具调用失败，退回工具名
      return this.name;
    }
  }
}

/** 已经是 `MicaTool` 实例的直接用；纯对象换成实例。 */
export function toMicaTool(tool: MicaTool | PluginToolDescriptor): MicaTool {
  return typeof (tool as MicaTool).executeTimed === 'function'
    ? (tool as MicaTool)
    : createPluginTool(tool as PluginToolDescriptor);
}

import { formatError } from './utils/formatError.js';
import type { ToolResult } from './types.js';

export interface ToolExecuteCallbacks {
  onChunk?: (chunk: string) => void;
  signal?: AbortSignal;
  context?: unknown;
}

export interface ValidationResult {
  valid: boolean;
  message?: string;
}

export type ToolInputSchema = {
  type?: string;
  properties?: Record<string, { type?: string | string[]; [key: string]: unknown }>;
  required?: string[];
  [key: string]: unknown;
};

export type ToolInput = Record<string, unknown>;
export type ToolSafetyOptions = {
  readOnly?: boolean;
  /** `mcp` 标出由 MCP server 提供的工具；其余一律按内置工具处理。 */
  source?: ToolSource;
  /** Original MCP server name when `source` is `mcp`. */
  mcpServer?: string;
};

/** 目录里只有「内置」与「MCP」两类：插件在会话期注册的工具同样是产品内置能力。 */
export type ToolSource = 'builtin' | 'mcp';

export type ToolScheduleOptions = {
  /**
   * 执行期只是等待外部条件（后台任务、进程、端口、终端输出…）的工具。调度器会立刻
   * 启动它，让它与同一条消息里其余工具调用重叠，等其余调用全部完成后再回收结果——
   * 否则模型「一边等测试、一边改文档」会被整条消息的串行语义挡住。只给 `wait_for` /
   * `pty_wait` 这类纯等待工具声明。
   */
  overlappable?: boolean;
};

export abstract class MicaTool {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
  readOnly: boolean;
  source: ToolSource;
  mcpServer?: string;
  overlappable: boolean;

  constructor(
    name: string,
    description: string,
    input_schema: ToolInputSchema,
    options: ToolSafetyOptions & ToolScheduleOptions = {},
  ) {
    this.name = name;
    this.description = description;
    this.input_schema = input_schema;
    this.readOnly = options.readOnly ?? false;
    this.source = options.source ?? 'builtin';
    this.mcpServer = options.mcpServer;
    this.overlappable = options.overlappable ?? false;
  }

  validateInput(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return {
        valid: false,
        message: `工具输入应为 object 类型，实际为 ${Array.isArray(input) ? 'array' : typeof input}`,
      };
    }
    const record = input as Record<string, unknown>;
    const required = this.input_schema.required || [];
    for (const key of required) {
      if (!(key in record) || record[key] === undefined || record[key] === null) {
        return { valid: false, message: `缺少必需参数 ${key}` };
      }
    }
    const properties = this.input_schema.properties ?? {};
    for (const [key, value] of Object.entries(record)) {
      if (value === undefined || value === null) continue;
      const prop = properties[key];
      const expected = prop?.type;
      if (!expected) continue;
      if (!matchesJsonSchemaType(value, expected)) {
        return {
          valid: false,
          message: `参数 ${key} 应为 ${expected} 类型，实际为 ${Array.isArray(value) ? 'array' : typeof value}`,
        };
      }
    }
    return { valid: true };
  }

  abstract execute(input: ToolInput, callbacks?: ToolExecuteCallbacks): Promise<ToolResult>;
  abstract onToolUseDisplayText(input: ToolInput): string;

  async executeTimed(input: ToolInput, callbacks?: ToolExecuteCallbacks): Promise<ToolResult> {
    try {
      return await this.execute(input, callbacks);
    } catch (error) {
      return `工具 ${this.name} 执行失败：\n${formatError(error)}`;
    }
  }
}

function matchesJsonSchemaType(value: unknown, expected: string | string[]): boolean {
  const expectedTypes = Array.isArray(expected) ? expected : [expected];
  return expectedTypes.some((type) => {
    if (type === 'array') return Array.isArray(value);
    if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (type === 'object') return Boolean(value && typeof value === 'object' && !Array.isArray(value));
    return typeof value === type;
  });
}

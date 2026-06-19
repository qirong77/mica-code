import { formatError } from './utils/formatError.js';

export interface ToolExecuteCallbacks {
  onChunk?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface ValidationResult {
  valid: boolean;
  message?: string;
}

export abstract class MicaTool {
  name: string;
  description: string;
  input_schema: any;

  constructor(name: string, description: string, input_schema: any) {
    this.name = name;
    this.description = description;
    this.input_schema = input_schema;
  }

  validateInput(input: Record<string, any>): ValidationResult {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return {
        valid: false,
        message: `工具输入应为 object 类型，实际为 ${Array.isArray(input) ? 'array' : typeof input}`,
      };
    }
    const required = (this.input_schema.required as string[]) || [];
    for (const key of required) {
      if (!(key in input) || input[key] === undefined || input[key] === null) {
        return { valid: false, message: `缺少必需参数 ${key}` };
      }
    }
    const properties = (this.input_schema.properties as Record<string, any>) ?? {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined || value === null) continue;
      const prop = properties[key];
      const expected = prop?.type;
      if (!expected) continue;
      if (!matchesJsonSchemaType(value, expected)) {
        return { valid: false, message: `参数 ${key} 应为 ${expected} 类型，实际为 ${Array.isArray(value) ? 'array' : typeof value}` };
      }
    }
    return { valid: true };
  }

  abstract execute(input: Record<string, any>, callbacks?: ToolExecuteCallbacks): Promise<string>;
  abstract onToolUseDisplayText(input: Record<string, any>): string;

  async executeTimed(input: Record<string, any>, callbacks?: ToolExecuteCallbacks): Promise<string> {
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

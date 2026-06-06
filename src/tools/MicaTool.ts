import { formatError } from '../utils/formatError';
import { MessageBarAPI } from '../components/ui/components/MessageBar/index.js';

const SLOW_TOOL_THRESHOLD_MS = 5000;

export interface ToolExecuteCallbacks {
  onChunk?: (chunk: string) => void;
}

export interface ValidationResult {
  valid: boolean;
  message?: string;
}

export abstract class MicaTool {
  name: string;
  description: string;
  input_schema: any;

  private _slowMsgId: string | null = null;

  constructor(name: string, description: string, input_schema: any) {
    this.name = name;
    this.description = description;
    this.input_schema = input_schema;
  }

  validateInput(input: Record<string, any>): ValidationResult {
    const required = (this.input_schema.required as string[]) || [];
    for (const key of required) {
      if (!(key in input) || input[key] === undefined || input[key] === null) {
        return { valid: false, message: `缺少必需参数 ${key}` };
      }
      const prop = (this.input_schema.properties as Record<string, any>)?.[key];
      if (prop?.type === 'string' && typeof input[key] !== 'string') {
        return { valid: false, message: `参数 ${key} 应为 string 类型，实际为 ${typeof input[key]}` };
      }
    }
    return { valid: true };
  }

  abstract execute(input: Record<string, any>, callbacks?: ToolExecuteCallbacks): Promise<string>;
  abstract onToolUseDisplayText(input: Record<string, any>): string;
  abstract getSlowText(elapsedMs: number, input: Record<string, any>): string;

  async executeTimed(input: Record<string, any>, callbacks?: ToolExecuteCallbacks): Promise<string> {
    const startTime = Date.now();

    const slowTimer = setTimeout(() => {
      this._showSlowMsg(this.getSlowText(Date.now() - startTime, input));
    }, SLOW_TOOL_THRESHOLD_MS);

    try {
      return await this.execute(input, callbacks);
    } catch (error) {
      return `工具 ${this.name} 执行失败：\n${formatError(error)}`;
    } finally {
      clearTimeout(slowTimer);
      this._hideSlowMsg(this.getSlowText(Date.now() - startTime, input));
    }
  }

  private _showSlowMsg(text: string) {
    const id = `slow-${this.name}`;
    if (this._slowMsgId) {
      MessageBarAPI.removeMessage(this._slowMsgId);
    }
    this._slowMsgId = id;
    MessageBarAPI.addMessage({ id, text });
  }

  private _hideSlowMsg(text: string) {
    const id = `slow-${this.name}`;
    if (this._slowMsgId) {
      MessageBarAPI.removeMessage(this._slowMsgId);
    }
    MessageBarAPI.addMessage({ id, text });
    setTimeout(() => MessageBarAPI.removeMessage(id), 3000);
    this._slowMsgId = null;
  }
}

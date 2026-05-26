import { formatError } from '../utils/formatError';
import { MessageBarAPI } from '../components/ui/components/MessageBar/index.js';

const SLOW_TOOL_THRESHOLD_MS = 3000;

export interface ToolExecuteCallbacks {
  onChunk?: (chunk: string) => void;
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

  abstract execute(input: Record<string, any>, callbacks?: ToolExecuteCallbacks): Promise<string>;
  abstract onToolUseDisplayText(input: Record<string, any>): string;
  abstract getSlowText(elapsedMs: number, input: Record<string, any>): string;

  async executeTimed(input: Record<string, any>, callbacks?: ToolExecuteCallbacks): Promise<string> {
    const startTime = Date.now();
    let timer: ReturnType<typeof setInterval> | null = null;

    timer = setInterval(() => {
      const elapsed = Date.now() - startTime;
      if (elapsed >= SLOW_TOOL_THRESHOLD_MS) {
        this._showSlowMsg(this.getSlowText(elapsed, input));
      }
    }, SLOW_TOOL_THRESHOLD_MS);

    try {
      return await this.execute(input, callbacks);
    } catch (error) {
      return `工具 ${this.name} 执行失败：\n${formatError(error)}`;
    } finally {
      clearInterval(timer);
      this._hideSlowMsg(this.getSlowText(Date.now() - startTime, input));
    }
  }

  private _showSlowMsg(text: string) {
    if (this._slowMsgId) {
      MessageBarAPI.removeMessage(this._slowMsgId);
    }
    this._slowMsgId = `slow-${this.name}-${Date.now()}`;
    MessageBarAPI.addMessage({ id: this._slowMsgId, text });
  }

  private _hideSlowMsg(text: string) {
    if (this._slowMsgId) {
      MessageBarAPI.removeMessage(this._slowMsgId);
    }
    const id = `slow-${this.name}-done`;
    MessageBarAPI.addMessage({ id, text });
    setTimeout(() => MessageBarAPI.removeMessage(id), 3000);
    this._slowMsgId = null;
  }
}

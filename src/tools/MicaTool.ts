import { formatError } from '../utils/formatError';

const SLOW_TOOL_THRESHOLD_MS = 3000;

export interface ToolExecuteCallbacks {
  onChunk?: (chunk: string) => void;
}

export abstract class MicaTool {
  static onSlowTool?: (toolName: string, elapsedMs: number, done?: boolean) => void;

  name: string;
  description: string;
  input_schema: any;

  constructor(name: string, description: string, input_schema: any) {
    this.name = name;
    this.description = description;
    this.input_schema = input_schema;
  }

  abstract execute(input: Record<string, any>, callbacks?: ToolExecuteCallbacks): Promise<string>;
  abstract onToolUseDisplayText(input: Record<string, any>): string;

  async executeTimed(input: Record<string, any>, callbacks?: ToolExecuteCallbacks): Promise<string> {
    const startTime = Date.now();
    let timer: ReturnType<typeof setInterval> | null = null;

    const slowHandler = MicaTool.onSlowTool;
    if (slowHandler) {
      timer = setInterval(() => {
        const elapsed = Date.now() - startTime;
        if (elapsed >= SLOW_TOOL_THRESHOLD_MS) {
          slowHandler(this.name, elapsed);
        }
      }, SLOW_TOOL_THRESHOLD_MS);
    }

    try {
      return await this.execute(input, callbacks);
    } catch (error) {
      return `工具 ${this.name} 执行失败：\n${formatError(error)}`;
    } finally {
      if (timer) clearInterval(timer);
      slowHandler?.(this.name, Date.now() - startTime, true);
    }
  }
}

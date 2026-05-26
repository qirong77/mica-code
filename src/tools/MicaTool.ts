const SLOW_TOOL_THRESHOLD_MS = 3000;

export interface ToolExecuteCallbacks {
  onChunk?: (chunk: string) => void;
  onLongRunning?: (elapsedMs: number) => void;
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

  abstract execute(input: Record<string, any>, callbacks?: ToolExecuteCallbacks): Promise<string>;
  abstract onToolUseDisplayText(input: Record<string, any>): string;

  async executeTimed(input: Record<string, any>, callbacks?: ToolExecuteCallbacks): Promise<string> {
    const startTime = Date.now();
    let timer: ReturnType<typeof setInterval> | null = null;

    if (callbacks?.onLongRunning) {
      const cb = callbacks.onLongRunning;
      timer = setInterval(() => {
        const elapsed = Date.now() - startTime;
        if (elapsed >= SLOW_TOOL_THRESHOLD_MS) {
          cb(elapsed);
        }
      }, SLOW_TOOL_THRESHOLD_MS);
    }

    try {
      return await this.execute(input, callbacks);
    } finally {
      if (timer) clearInterval(timer);
      callbacks?.onLongRunning?.(Date.now() - startTime);
    }
  }
}

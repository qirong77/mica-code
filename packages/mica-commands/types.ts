export type CommandScope = 'local-only' | 'remote-capable' | 'remote-only';

export type MicaCommand = {
  name: string;
  description?: string;
  completionItems?: MicaCommandCompletionItems;
  scope?: CommandScope;
  allowDuringTurn?: boolean;
  pluginId: string;
  handler(ctx: CommandContext, args: string): void | CommandResult | Promise<void | CommandResult>;
};

export type MicaCommandCompletionItems = MicaCommandCompletionItem[] | (() => MicaCommandCompletionItem[]);

export type MicaCommandCompletionItem = {
  arg: string;
  label?: string;
  description?: string;
};

export type CommandContext = {
  services?: unknown;
  runtime?: unknown;
};

export type CommandResult =
  | {
      ok: true;
      handled?: boolean;
      /** 一句话结果，界面可以直接显示（成功时也一样）。 */
      message?: string;
      /**
       * 结构化结果，给宿主或脚本用（`mica commit --format json`）。
       *
       * 命令是插件实现的产品能力，宿主不该为了拿一个哈希去解析人类可读的文案。
       */
      data?: unknown;
    }
  | { ok: false; error: unknown; message?: string; data?: unknown };

export type ParsedCommand = {
  command: MicaCommand;
  args: string;
  raw: string;
};

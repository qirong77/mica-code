export type CommandScope = 'local-only' | 'remote-capable' | 'remote-only';

export type MicaCommand = {
  name: string;
  description?: string;
  scope?: CommandScope;
  allowDuringTurn?: boolean;
  pluginId: string;
  handler(ctx: CommandContext, args: string): void | CommandResult | Promise<void | CommandResult>;
};

export type CommandContext = {
  services?: unknown;
  runtime?: unknown;
};

export type CommandResult =
  | { ok: true; handled?: boolean }
  | { ok: false; error: unknown; message?: string };

export type ParsedCommand = {
  command: MicaCommand;
  args: string;
  raw: string;
};

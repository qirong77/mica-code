import type { Disposable } from '@packages/mica-common/index.js';
import type { CommandContext, CommandListOptions, CommandResult, MicaCommand, ParsedCommand } from './types.js';

export class CommandRegistry {
  private readonly commands = new Map<string, MicaCommand>();

  register(command: MicaCommand): Disposable {
    const name = normalizeCommandName(command.name);
    if (this.commands.has(name)) {
      throw new Error(`Command already registered: ${name}`);
    }

    this.commands.set(name, { ...command, name });

    return {
      dispose: () => {
        if (this.commands.get(name)?.pluginId === command.pluginId) {
          this.commands.delete(name);
        }
      },
    };
  }

  resolve(raw: string): ParsedCommand | null {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('/')) return null;

    const body = trimmed.slice(1);
    const [namePart = '', ...rest] = body.split(/\s+/);
    const name = normalizeCommandName(namePart);
    if (!name) return null;

    const command = this.commands.get(name);
    if (!command) return null;

    return {
      command,
      args: rest.join(' ').trim(),
      raw,
    };
  }

  async execute(raw: string, ctx: CommandContext = {}): Promise<CommandResult> {
    const parsed = this.resolve(raw);
    if (!parsed) {
      return { ok: false, error: new Error(`Unknown command: ${raw}`), message: 'Unknown command' };
    }

    try {
      const result = await parsed.command.handler(ctx, parsed.args);
      return result ?? { ok: true, handled: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  list(options: CommandListOptions = {}): MicaCommand[] {
    const commands = [...this.commands.values()];
    const filtered = options.includeHidden ? commands : commands.filter((command) => !command.hidden);
    return filtered.sort((a, b) => a.name.localeCompare(b.name));
  }
}

function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\//, '').toLowerCase();
}

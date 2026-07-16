export type RunCliInvocation = {
  mode: 'run';
  format: 'json';
  prompt: string;
  sessionId?: string;
  cwd?: string;
  model?: string;
  variant?: string;
  maxTurns?: number;
  dangerouslySkipPermissions: boolean;
  mcpConfigPath?: string;
  strictMcpConfig: boolean;
};

export type CliInvocation =
  | { mode: 'interactive'; sessionId?: string }
  | RunCliInvocation
  | { mode: 'models'; verbose: boolean }
  | { mode: 'version' }
  | { mode: 'help' }
  | { mode: 'error'; message: string };

export const CLI_USAGE = [
  'Usage:',
  '  mica',
  '  mica --resume <session-id>',
  '  mica --version',
  '  mica models',
  '  mica run --format json [options] "<prompt>"',
  '',
  'Run options:',
  '  --session <id>                    Resume a Mica session',
  '  --dir <path>                      Set the task working directory',
  '  --model <provider/model>          Override provider and model',
  '  --variant <effort>                none|low|medium|high|xhigh',
  '  --max-turns <count>               Limit model round trips',
  '  --dangerously-skip-permissions    Autonomous runtime mode',
  '  --mcp-config <path>               Load MCP servers from a JSON file',
  '  --strict-mcp-config               Do not merge the local MCP config',
].join('\n');

export function parseCliArgs(argv: string[]): CliInvocation {
  if (argv.length === 0) return { mode: 'interactive' };
  if (argv[0] === '--resume') {
    const value = takeValue(argv, 1, '--resume');
    if (!value.ok) return value.error;
    if (argv.length !== 2) return cliError(`Unknown option: ${argv.slice(2).join(' ')}`);
    return { mode: 'interactive', sessionId: value.value };
  }
  if (argv[0]?.startsWith('--resume=')) {
    const sessionId = argv[0].slice('--resume='.length);
    if (!sessionId) return cliError('Missing value for --resume.');
    if (argv.length !== 1) return cliError(`Unknown option: ${argv.slice(1).join(' ')}`);
    return { mode: 'interactive', sessionId };
  }
  if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') return { mode: 'version' };
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') return { mode: 'help' };
  if (argv[0] === 'models') {
    const rest = argv.slice(1);
    if (rest.length === 0) return { mode: 'models', verbose: false };
    if (rest.length === 1 && rest[0] === '--verbose') return { mode: 'models', verbose: true };
    return { mode: 'error', message: `Unknown models option: ${rest.join(' ')}` };
  }
  if (argv[0] !== 'run') return { mode: 'interactive' };

  let format: 'json' | undefined;
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let variant: string | undefined;
  let maxTurns: number | undefined;
  let dangerouslySkipPermissions = false;
  let mcpConfigPath: string | undefined;
  let strictMcpConfig = false;
  const positionals: string[] = [];
  let positionalOnly = false;

  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!;
    if (positionalOnly) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      positionalOnly = true;
      continue;
    }
    if (arg === '--format') {
      const value = takeValue(argv, ++index, '--format');
      if (!value.ok) return value.error;
      if (value.value !== 'json') return cliError('Unsupported --format value. Use --format json.');
      format = 'json';
      continue;
    }
    if (arg.startsWith('--format=')) {
      if (arg.slice('--format='.length) !== 'json') {
        return cliError('Unsupported --format value. Use --format json.');
      }
      format = 'json';
      continue;
    }

    const valueOption = parseValueOption(arg, argv, index, [
      '--session',
      '--dir',
      '--model',
      '--variant',
      '--max-turns',
      '--mcp-config',
    ]);
    if (valueOption) {
      if (!valueOption.ok) return valueOption.error;
      index = valueOption.nextIndex;
      switch (valueOption.name) {
        case '--session':
          sessionId = valueOption.value;
          break;
        case '--dir':
          cwd = valueOption.value;
          break;
        case '--model':
          model = valueOption.value;
          break;
        case '--variant':
          variant = valueOption.value;
          break;
        case '--mcp-config':
          mcpConfigPath = valueOption.value;
          break;
        case '--max-turns': {
          const parsed = Number(valueOption.value);
          if (!Number.isInteger(parsed) || parsed <= 0) return cliError('--max-turns must be a positive integer.');
          maxTurns = parsed;
          break;
        }
      }
      continue;
    }

    if (arg === '--dangerously-skip-permissions') {
      dangerouslySkipPermissions = true;
      continue;
    }
    if (arg === '--strict-mcp-config') {
      strictMcpConfig = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') return { mode: 'help' };
    // Multica appends the task prompt as the final argv item without a `--`
    // sentinel. Accept a final prompt that happens to begin with a dash.
    if (arg.startsWith('-') && positionals.length === 0 && index !== argv.length - 1) {
      return cliError(`Unknown option: ${arg}`);
    }
    positionals.push(arg);
  }

  if (format !== 'json') return cliError('mica run currently requires --format json.');
  const prompt = positionals.join(' ').trim();
  if (!prompt) return cliError(CLI_USAGE);

  return {
    mode: 'run',
    format,
    prompt,
    sessionId,
    cwd,
    model,
    variant,
    maxTurns,
    dangerouslySkipPermissions,
    mcpConfigPath,
    strictMcpConfig,
  };
}

function parseValueOption(
  arg: string,
  argv: string[],
  index: number,
  names: string[],
):
  | { ok: true; name: string; value: string; nextIndex: number }
  | { ok: false; error: { mode: 'error'; message: string } }
  | null {
  for (const name of names) {
    if (arg === name) {
      const value = takeValue(argv, index + 1, name);
      if (!value.ok) return { ok: false, error: value.error };
      return { ok: true, name, value: value.value, nextIndex: index + 1 };
    }
    if (arg.startsWith(`${name}=`)) {
      const value = arg.slice(name.length + 1);
      if (!value) return { ok: false, error: cliError(`Missing value for ${name}.`) };
      return { ok: true, name, value, nextIndex: index };
    }
  }
  return null;
}

function takeValue(
  argv: string[],
  index: number,
  name: string,
): { ok: true; value: string } | { ok: false; error: { mode: 'error'; message: string } } {
  const value = argv[index];
  if (!value) return { ok: false, error: cliError(`Missing value for ${name}.`) };
  return { ok: true, value };
}

function cliError(message: string): { mode: 'error'; message: string } {
  return { mode: 'error', message };
}

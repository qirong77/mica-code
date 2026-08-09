export type ExecCliInvocation = {
  mode: 'exec';
  json: boolean;
  prompt: string;
  sessionId?: string;
  cwd?: string;
  model?: string;
  variant?: string;
  role?: string;
  maxTurns?: number;
  thinking: boolean;
  noSave: boolean;
  dangerouslySkipPermissions: boolean;
  mcpConfigPath?: string;
  strictMcpConfig: boolean;
  mcpInitTimeoutMs?: number;
};

export type DaemonCliInvocation = {
  mode: 'daemon';
  server?: string;
  name?: string;
};

export type CompactCliInvocation = {
  mode: 'compact';
  sessionId: string;
  cwd?: string;
  force: boolean;
  pruneOnly: boolean;
  format: 'json';
};

export type CommitCliInvocation = {
  mode: 'commit';
  cwd?: string;
  format: 'json';
};

export type AppServerCliInvocation = {
  mode: 'app-server';
  sessionId?: string;
  cwd?: string;
  model?: string;
  variant?: string;
  role?: string;
  maxTurns?: number;
  mcpConfigPath?: string;
  strictMcpConfig: boolean;
  mcpInitTimeoutMs?: number;
  thinking: boolean;
};

export type CliInvocation =
  | { mode: 'interactive'; sessionId?: string }
  | ExecCliInvocation
  | DaemonCliInvocation
  | CompactCliInvocation
  | CommitCliInvocation
  | AppServerCliInvocation
  | { mode: 'models'; verbose: boolean; json: boolean }
  | { mode: 'version' }
  | { mode: 'help' }
  | { mode: 'error'; message: string };

export const CLI_USAGE = [
  'Usage:',
  '  mica',
  '  mica --resume <session-id>',
  '  mica --version',
  '  mica models',
  '  mica models --json',
  '  mica exec [--json] [options] "<prompt>"',
  '  mica daemon [--server <url>] [--name <name>]',
  '  mica compact --session <id> [--dir <path>] [--force] [--prune-only]',
  '  mica commit [--dir <path>]',
  '  mica app-server [--session <id>] [--dir <path>] [--model <id>] [--variant <effort>] [--role <name>]',
  '',
  'Run options:',
  '  --session <id>                    Resume a Mica session',
  '  --dir <path>                      Set the task working directory',
  '  --model <provider/model>          Override provider and model',
  '  --variant <effort>                none|low|medium|high|xhigh',
  '  --role <name>                     Override the agent role',
  '  --max-turns <count>               Limit model round trips',
  '  --thinking                        Include reasoning events in JSON output',
  '  --json                            Emit Codex exec-style ThreadEvent JSONL',
  '  --no-save                         Run without persisting a session file',
  '  --dangerously-skip-permissions    Autonomous runtime mode',
  '  --mcp-config <path>               Load MCP servers from a JSON file',
  '  --strict-mcp-config               Do not merge the local MCP config',
  '  --mcp-init-timeout-ms <ms>        Limit connect + tools/list time per MCP server',
  '',
  'Daemon options:',
  '  --server <url>                    Sync server base URL',
  '  --name <name>                     Machine display name (default: hostname)',
  '',
  'Compact options:',
  '  --session <id>                    Compress the given session into a checkpoint',
  '  --dir <path>                      Set the working directory',
  '  --force                           Force a summary even when history is short',
  '  --prune-only                      Only perform local cleanup; never call a model',
  '',
  'Commit options:',
  '  --dir <path>                      Set the working directory',
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
    const options = new Set(rest);
    if (rest.every((option) => option === '--verbose' || option === '--json')) {
      return { mode: 'models', verbose: options.has('--verbose'), json: options.has('--json') };
    }
    return { mode: 'error', message: `Unknown models option: ${rest.join(' ')}` };
  }
  if (argv[0] === 'daemon') {
    let server: string | undefined;
    let name: string | undefined;
    for (let index = 1; index < argv.length; index++) {
      const arg = argv[index]!;
      const valueOption = parseValueOption(arg, argv, index, ['--server', '--name']);
      if (valueOption) {
        if (!valueOption.ok) return valueOption.error;
        index = valueOption.nextIndex;
        if (valueOption.name === '--server') server = valueOption.value;
        if (valueOption.name === '--name') name = valueOption.value;
        continue;
      }
      if (arg === '--help' || arg === '-h') return { mode: 'help' };
      return cliError(`Unknown daemon option: ${arg}`);
    }
    return { mode: 'daemon', server, name };
  }
  if (argv[0] === 'compact') {
    let sessionId: string | undefined;
    let cwd: string | undefined;
    let force = false;
    let pruneOnly = false;
    for (let index = 1; index < argv.length; index++) {
      const arg = argv[index]!;
      const valueOption = parseValueOption(arg, argv, index, ['--session', '--dir']);
      if (valueOption) {
        if (!valueOption.ok) return valueOption.error;
        index = valueOption.nextIndex;
        if (valueOption.name === '--session') sessionId = valueOption.value;
        if (valueOption.name === '--dir') cwd = valueOption.value;
        continue;
      }
      if (arg === '--force') {
        force = true;
        continue;
      }
      if (arg === '--prune-only') {
        pruneOnly = true;
        continue;
      }
      if (arg === '--help' || arg === '-h') return { mode: 'help' };
      return cliError(`Unknown compact option: ${arg}`);
    }
    if (!sessionId) return cliError('Missing value for --session.');
    return { mode: 'compact', sessionId, cwd, force, pruneOnly, format: 'json' };
  }
  if (argv[0] === 'commit') {
    let cwd: string | undefined;
    let format: 'json' = 'json';
    for (let index = 1; index < argv.length; index++) {
      const arg = argv[index]!;
      const valueOption = parseValueOption(arg, argv, index, ['--dir', '--format']);
      if (valueOption) {
        if (!valueOption.ok) return valueOption.error;
        index = valueOption.nextIndex;
        if (valueOption.name === '--dir') cwd = valueOption.value;
        if (valueOption.name === '--format') {
          if (valueOption.value !== 'json') return cliError(`Unsupported --format: ${valueOption.value}`);
          format = 'json';
        }
        continue;
      }
      if (arg === '--help' || arg === '-h') return { mode: 'help' };
      return cliError(`Unknown commit option: ${arg}`);
    }
    return { mode: 'commit', cwd, format };
  }
  if (argv[0] === 'app-server') {
    let sessionId: string | undefined;
    let cwd: string | undefined;
    let model: string | undefined;
    let variant: string | undefined;
    let role: string | undefined;
    let maxTurns: number | undefined;
    let mcpConfigPath: string | undefined;
    let strictMcpConfig = false;
    let mcpInitTimeoutMs: number | undefined;
    let thinking = false;
    for (let index = 1; index < argv.length; index++) {
      const arg = argv[index]!;
      const valueOption = parseValueOption(arg, argv, index, [
        '--session',
        '--dir',
        '--model',
        '--variant',
        '--role',
        '--max-turns',
        '--mcp-config',
        '--mcp-init-timeout-ms',
      ]);
      if (valueOption) {
        if (!valueOption.ok) return valueOption.error;
        index = valueOption.nextIndex;
        if (valueOption.name === '--session') sessionId = valueOption.value;
        if (valueOption.name === '--dir') cwd = valueOption.value;
        if (valueOption.name === '--model') model = valueOption.value;
        if (valueOption.name === '--variant') variant = valueOption.value;
        if (valueOption.name === '--role') role = valueOption.value;
        if (valueOption.name === '--max-turns') maxTurns = Number(valueOption.value);
        if (valueOption.name === '--mcp-config') mcpConfigPath = valueOption.value;
        if (valueOption.name === '--mcp-init-timeout-ms') mcpInitTimeoutMs = Number(valueOption.value);
        continue;
      }
      if (arg === '--strict-mcp-config') {
        strictMcpConfig = true;
        continue;
      }
      if (arg === '--thinking') {
        thinking = true;
        continue;
      }
      if (arg === '--help' || arg === '-h') return { mode: 'help' };
      return cliError(`Unknown app-server option: ${arg}`);
    }
    return {
      mode: 'app-server',
      sessionId,
      cwd,
      model,
      variant,
      role,
      maxTurns,
      mcpConfigPath,
      strictMcpConfig,
      mcpInitTimeoutMs,
      thinking,
    };
  }
  if (argv[0] !== 'exec') return { mode: 'interactive' };

  let json = false;
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let variant: string | undefined;
  let role: string | undefined;
  let maxTurns: number | undefined;
  let thinking = false;
  let noSave = false;
  let dangerouslySkipPermissions = false;
  let mcpConfigPath: string | undefined;
  let strictMcpConfig = false;
  let mcpInitTimeoutMs: number | undefined;
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
    const valueOption = parseValueOption(arg, argv, index, [
      '--session',
      '--dir',
      '--model',
      '--variant',
      '--role',
      '--max-turns',
      '--mcp-config',
      '--mcp-init-timeout-ms',
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
        case '--role':
          role = valueOption.value;
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
        case '--mcp-init-timeout-ms': {
          const parsed = Number(valueOption.value);
          if (!Number.isInteger(parsed) || parsed <= 0) {
            return cliError('--mcp-init-timeout-ms must be a positive integer.');
          }
          mcpInitTimeoutMs = parsed;
          break;
        }
      }
      continue;
    }

    if (arg === '--dangerously-skip-permissions') {
      dangerouslySkipPermissions = true;
      continue;
    }
    if (arg === '--thinking') {
      thinking = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--no-save') {
      noSave = true;
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

  const prompt = positionals.join(' ').trim();
  if (!prompt) return cliError(CLI_USAGE);

  return {
    mode: 'exec',
    json,
    prompt,
    sessionId,
    cwd,
    model,
    variant,
    role,
    maxTurns,
    thinking,
    noSave,
    dangerouslySkipPermissions,
    mcpConfigPath,
    strictMcpConfig,
    mcpInitTimeoutMs,
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

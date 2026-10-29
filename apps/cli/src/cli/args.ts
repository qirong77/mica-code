import { RUNTIME_NAME } from '@packages/mica-config/brand.js';

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

export type CompactCliInvocation = {
  mode: 'compact';
  sessionId: string;
  cwd?: string;
  force: boolean;
  pruneOnly: boolean;
  toolResultsOnly: boolean;
  format: 'json';
};

export type CommitCliInvocation = {
  mode: 'commit';
  cwd?: string;
};

/**
 * 配置页动作的一次性执行入口（配置页的「注册」这类按钮调它）。
 *
 * 内部通道，不出现在 usage 里：调用方是配置页宿主，参数形状由 `mica-config-ui` 决定。
 */
export type PluginActionCliInvocation = {
  mode: 'plugin-action';
  pluginId: string;
  action: string;
  /** 页面带上来的设置草稿；没传就是「按磁盘上的设置执行」。 */
  values?: Record<string, string>;
};

export type AppServerCliInvocation = {
  mode: 'app-server';
  sessionId?: string;
  /** 派生出这条会话的父会话 id（新建时才用；resume 以文件里记录的为准）。 */
  parentSessionId?: string;
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
  | CompactCliInvocation
  | CommitCliInvocation
  | PluginActionCliInvocation
  | AppServerCliInvocation
  | { mode: 'models'; verbose: boolean; json: boolean }
  | { mode: 'version' }
  | { mode: 'help' }
  | { mode: 'error'; message: string };

export const CLI_USAGE = [
  'Usage:',
  `  ${RUNTIME_NAME}`,
  `  ${RUNTIME_NAME} --resume <session-id>`,
  `  ${RUNTIME_NAME} --version`,
  `  ${RUNTIME_NAME} models`,
  `  ${RUNTIME_NAME} models --json`,
  `  ${RUNTIME_NAME} exec [--json] [options] "<prompt>"`,
  `  ${RUNTIME_NAME} compact --session <id> [--dir <path>] [--force] [--prune-only] [--tool-results-only]`,
  `  ${RUNTIME_NAME} commit [--dir <path>]`,
  `  ${RUNTIME_NAME} app-server [--session <id>] [--dir <path>] [--model <id>] [--variant <effort>] [--role <name>]`,
  '                                    [--parent <session-id>]',
  '',
  'Run options:',
  '  --session <id>                    Resume a Mica session',
  '  --parent <session-id>             Record which session spawned this new one (nests it in the sidebar)',
  '  --dir, --cd <path>                Set the task working directory',
  '  --model <provider/model>          Override provider and model',
  '  --variant <effort>                Model-declared level (see `models --json` efforts)',
  '  --role <name>                     Override the agent role',
  '  --max-turns <count>               Limit model round trips',
  '  --thinking                        Include reasoning events in JSON output',
  '  --json                            Emit Codex exec-style ThreadEvent JSONL',
  '  --no-save                         Run without persisting a session file',
  '  --dangerously-skip-permissions    Compatibility flag; headless mode already runs without prompts',
  '  --mcp-config <path>               Load MCP servers from a JSON file',
  '  --strict-mcp-config               Do not merge the local MCP config',
  '  --mcp-init-timeout-ms <ms>        Limit connect + tools/list time per MCP server',
  '',
  'Codex compatibility (accepted verbatim from codex-family drivers):',
  '  -c model_reasoning_effort=<e>     none|minimal|low|medium|high|xhigh|max',
  '  -c model_reasoning_summary=<mode> none turns reasoning events off',
  '  --dangerously-bypass-approvals-and-sandbox',
  '                                    Same as --dangerously-skip-permissions',
  '  --enable <feature>, --skip-git-repo-check',
  '                                    Accepted and ignored',
  '',
  'Compact options:',
  '  --session <id>                    Compress the given session into a checkpoint',
  '  --dir <path>                      Set the working directory',
  '  --force                           Force a summary even when history is short',
  '  --prune-only                      Only perform local cleanup; never call a model',
  '  --tool-results-only               Replace tool results with placeholders in place; never call a model or drop rounds',
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
  if (argv[0] === 'compact') {
    let sessionId: string | undefined;
    let cwd: string | undefined;
    let force = false;
    let pruneOnly = false;
    let toolResultsOnly = false;
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
      if (arg === '--tool-results-only') {
        toolResultsOnly = true;
        continue;
      }
      if (arg === '--help' || arg === '-h') return { mode: 'help' };
      return cliError(`Unknown compact option: ${arg}`);
    }
    if (!sessionId) return cliError('Missing value for --session.');
    return { mode: 'compact', sessionId, cwd, force, pruneOnly, toolResultsOnly, format: 'json' };
  }
  if (argv[0] === 'commit') {
    let cwd: string | undefined;
    for (let index = 1; index < argv.length; index++) {
      const arg = argv[index]!;
      const valueOption = parseValueOption(arg, argv, index, ['--dir', '--format']);
      if (valueOption) {
        if (!valueOption.ok) return valueOption.error;
        index = valueOption.nextIndex;
        if (valueOption.name === '--dir') cwd = valueOption.value;
        // 只有 JSON 一种输出；桌面端仍会带 `--format json`。
        if (valueOption.name === '--format' && valueOption.value !== 'json') {
          return cliError(`Unsupported --format: ${valueOption.value}`);
        }
        continue;
      }
      if (arg === '--help' || arg === '-h') return { mode: 'help' };
      return cliError(`Unknown commit option: ${arg}`);
    }
    return { mode: 'commit', cwd };
  }
  if (argv[0] === 'plugin-action') {
    let pluginId = '';
    let action = '';
    let values: Record<string, string> | undefined;
    for (let index = 1; index < argv.length; index++) {
      const arg = argv[index]!;
      const valueOption = parseValueOption(arg, argv, index, ['--plugin', '--action', '--values']);
      if (!valueOption) return cliError(`Unknown plugin-action option: ${arg}`);
      if (!valueOption.ok) return valueOption.error;
      index = valueOption.nextIndex;
      if (valueOption.name === '--plugin') pluginId = valueOption.value;
      if (valueOption.name === '--action') action = valueOption.value;
      if (valueOption.name === '--values') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(valueOption.value);
        } catch {
          return cliError('--values 必须是 JSON 对象');
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return cliError('--values 必须是 JSON 对象');
        }
        values = parsed as Record<string, string>;
      }
    }
    if (!pluginId) return cliError('plugin-action 缺少 --plugin');
    if (!action) return cliError('plugin-action 缺少 --action');
    return { mode: 'plugin-action', pluginId, action, values };
  }
  if (argv[0] === 'app-server') {
    let sessionId: string | undefined;
    let parentSessionId: string | undefined;
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
        '--parent',
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
        if (valueOption.name === '--parent') parentSessionId = valueOption.value;
        if (valueOption.name === '--dir') cwd = valueOption.value;
        if (valueOption.name === '--model') model = valueOption.value;
        if (valueOption.name === '--variant') variant = valueOption.value;
        if (valueOption.name === '--role') role = valueOption.value;
        if (valueOption.name === '--max-turns') maxTurns = Number(valueOption.value);
        if (valueOption.name === '--mcp-config') mcpConfigPath = valueOption.value;
        if (valueOption.name === '--mcp-init-timeout-ms') mcpInitTimeoutMs = Number(valueOption.value);
        continue;
      }
      // Codex app-server transport flags. A codex-family driver (e.g. Multica)
      // spawns `<agent> app-server --listen stdio://`; Mica's app-server is
      // always stdio, so accept and drop the transport flag instead of
      // rejecting it as an unknown option.
      if (arg === '--stdio') continue;
      if (arg === '--listen') {
        const transport = argv[index + 1];
        if (transport !== undefined && !transport.startsWith('--')) index++;
        continue;
      }
      if (arg.startsWith('--listen=')) continue;
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
      parentSessionId,
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
      '--cd',
      '--model',
      '--variant',
      '--role',
      '--max-turns',
      '--mcp-config',
      '--mcp-init-timeout-ms',
      '--enable',
    ]);
    if (valueOption) {
      if (!valueOption.ok) return valueOption.error;
      index = valueOption.nextIndex;
      switch (valueOption.name) {
        case '--session':
          sessionId = valueOption.value;
          break;
        case '--dir':
        // Codex spells the working directory `--cd`; treat both as the same knob.
        case '--cd':
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
        case '--enable': {
          // Codex feature toggles (e.g. `--enable unified_exec`) have no Mica
          // counterpart. Accept and drop them so a codex-family driver can pass
          // its own flags verbatim.
          break;
        }
      }
      continue;
    }

    // Codex renamed this flag to `--dangerously-bypass-approvals-and-sandbox`;
    // both mean "do not prompt", which is already how headless Mica runs.
    if (arg === '--dangerously-skip-permissions' || arg === '--dangerously-bypass-approvals-and-sandbox') {
      dangerouslySkipPermissions = true;
      continue;
    }
    if (arg === '--skip-git-repo-check') {
      // Codex refuses to run outside a git repository by default. Mica has no
      // such precondition, so the flag is accepted and dropped.
      continue;
    }
    if (arg === '-c' || (arg.startsWith('-c') && arg.length > 2)) {
      const override = arg === '-c' ? argv[index + 1] : arg.slice(2);
      if (override === undefined) return cliError('Missing value for -c.');
      if (arg === '-c') index++;
      const separator = override.indexOf('=');
      const key = separator === -1 ? override : override.slice(0, separator);
      const value = separator === -1 ? '' : override.slice(separator + 1);
      if (key === 'model_reasoning_effort' && value) {
        // 原样透传：`minimal` / `max` 是模型自己的档位名，折算成别的值会改变用户的选择。
        variant = value;
      } else if (key === 'model_reasoning_summary' && value) {
        thinking = value !== 'none';
      }
      // Other `-c` overrides target Codex `config.toml` keys Mica does not
      // model (web_search, sandbox modes, ...). Ignore them rather than
      // rejecting an otherwise valid codex invocation.
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

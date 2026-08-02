import { describe, expect, it } from 'vitest';
import { parseCliArgs } from './args.js';

describe('parseCliArgs', () => {
  it('keeps the no-argument invocation interactive', () => {
    expect(parseCliArgs([])).toEqual({ mode: 'interactive' });
  });

  it('parses interactive session resume flags', () => {
    expect(parseCliArgs(['--resume', 'session-1'])).toEqual({ mode: 'interactive', sessionId: 'session-1' });
    expect(parseCliArgs(['--resume=session-2'])).toEqual({ mode: 'interactive', sessionId: 'session-2' });
    expect(parseCliArgs(['--resume'])).toMatchObject({ mode: 'error' });
  });

  it('parses the exact argv shape used by Multica deveco runtimes', () => {
    expect(
      parseCliArgs([
        'run',
        '--format',
        'json',
        '--dangerously-skip-permissions',
        '--dir',
        '/work/task',
        '--model',
        'openai/gpt-5',
        '--variant',
        'high',
        '--role',
        'reviewer',
        '--session',
        'session-1',
        'fix tests',
      ]),
    ).toEqual({
      mode: 'run',
      format: 'json',
      prompt: 'fix tests',
      sessionId: 'session-1',
      cwd: '/work/task',
      model: 'openai/gpt-5',
      variant: 'high',
      role: 'reviewer',
      maxTurns: undefined,
      thinking: false,
      dangerouslySkipPermissions: true,
      mcpConfigPath: undefined,
      strictMcpConfig: false,
    });
  });

  it('parses equals-form flags and managed MCP options', () => {
    expect(
      parseCliArgs([
        'run',
        '--format=json',
        '--session=abc',
        '--max-turns=3',
        '--mcp-config=/tmp/mcp.json',
        '--strict-mcp-config',
        '--thinking',
        'continue',
      ]),
    ).toMatchObject({
      mode: 'run',
      sessionId: 'abc',
      maxTurns: 3,
      mcpConfigPath: '/tmp/mcp.json',
      strictMcpConfig: true,
      thinking: true,
      prompt: 'continue',
    });
  });

  it('supports version and model-discovery probes without entering the UI', () => {
    expect(parseCliArgs(['--version'])).toEqual({ mode: 'version' });
    expect(parseCliArgs(['models'])).toEqual({ mode: 'models', verbose: false });
    expect(parseCliArgs(['models', '--verbose'])).toEqual({ mode: 'models', verbose: true });
  });

  it('parses headless compact invocations', () => {
    expect(
      parseCliArgs(['compact', '--session', 'session-1', '--dir', '/work', '--force']),
    ).toEqual({
      mode: 'compact',
      sessionId: 'session-1',
      cwd: '/work',
      force: true,
      format: 'json',
    });
    expect(parseCliArgs(['compact', '--session=abc'])).toMatchObject({
      mode: 'compact',
      sessionId: 'abc',
      force: false,
    });
    expect(parseCliArgs(['compact'])).toMatchObject({ mode: 'error' });
    expect(parseCliArgs(['compact', '--nope', 'x'])).toMatchObject({ mode: 'error' });
  });

  it('accepts a Multica prompt whose first character is a dash', () => {
    expect(parseCliArgs(['run', '--format', 'json', '- fix the checklist'])).toMatchObject({
      mode: 'run',
      prompt: '- fix the checklist',
    });
    expect(parseCliArgs(['run', '--format', 'json', '--', '--help'])).toMatchObject({
      mode: 'run',
      prompt: '--help',
    });
  });

  it('rejects missing prompts, invalid counts, and unsupported formats', () => {
    expect(parseCliArgs(['run', '--format', 'json'])).toMatchObject({ mode: 'error' });
    expect(parseCliArgs(['run', '--format', 'text', 'hi'])).toMatchObject({ mode: 'error' });
    expect(parseCliArgs(['run', '--format=json', '--max-turns=0', 'hi'])).toMatchObject({ mode: 'error' });
  });
});

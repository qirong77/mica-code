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
        'continue',
      ]),
    ).toMatchObject({
      mode: 'run',
      sessionId: 'abc',
      maxTurns: 3,
      mcpConfigPath: '/tmp/mcp.json',
      strictMcpConfig: true,
      prompt: 'continue',
    });
  });

  it('supports version and model-discovery probes without entering the UI', () => {
    expect(parseCliArgs(['--version'])).toEqual({ mode: 'version' });
    expect(parseCliArgs(['models'])).toEqual({ mode: 'models', verbose: false });
    expect(parseCliArgs(['models', '--verbose'])).toEqual({ mode: 'models', verbose: true });
  });

  it('accepts a Multica prompt whose first character is a dash', () => {
    expect(parseCliArgs(['run', '--format', 'json', '- fix the checklist'])).toMatchObject({
      mode: 'run',
      prompt: '- fix the checklist',
    });
  });

  it('rejects missing prompts, invalid counts, and unsupported formats', () => {
    expect(parseCliArgs(['run', '--format', 'json'])).toMatchObject({ mode: 'error' });
    expect(parseCliArgs(['run', '--format', 'text', 'hi'])).toMatchObject({ mode: 'error' });
    expect(parseCliArgs(['run', '--format=json', '--max-turns=0', 'hi'])).toMatchObject({ mode: 'error' });
  });
});

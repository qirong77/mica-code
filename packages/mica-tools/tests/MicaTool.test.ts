import { describe, expect, it, afterEach } from 'vitest';
import { MicaTool } from '../MicaTool.js';
import {
  executeTool,
  getToolDefinitions,
  isToolPrimaryAgentOnly,
  isToolReadOnly,
  registerMcpTools,
  registerRuntimeTool,
  unregisterMcpTools,
  unregisterRuntimeTools,
} from '../registry.js';

class TestTool extends MicaTool {
  constructor(name = 'test_tool') {
    super(name, 'test tool', {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        limit: { type: 'integer' },
        dry_run: { type: 'boolean' },
      },
      required: ['file_path'],
    });
  }

  async execute(): Promise<string> {
    return 'ok';
  }

  onToolUseDisplayText(): string {
    return 'test';
  }
}

describe('MicaTool.validateInput', () => {
  const tool = new TestTool();

  it('rejects non-object root inputs without throwing', () => {
    expect(tool.validateInput(null as unknown as Record<string, unknown>)).toMatchObject({
      valid: false,
      message: expect.stringContaining('object'),
    });
    expect(tool.validateInput([] as unknown as Record<string, unknown>)).toMatchObject({
      valid: false,
      message: expect.stringContaining('array'),
    });
  });

  it('validates optional field types', () => {
    expect(tool.validateInput({ file_path: 'README.md', limit: 2, dry_run: false }).valid).toBe(true);
    expect(tool.validateInput({ file_path: 'README.md', limit: 2.5 })).toMatchObject({
      valid: false,
      message: expect.stringContaining('integer'),
    });
    expect(tool.validateInput({ file_path: 'README.md', dry_run: 'false' })).toMatchObject({
      valid: false,
      message: expect.stringContaining('boolean'),
    });
  });
});

describe('getToolDefinitions', () => {
  afterEach(() => {
    unregisterMcpTools();
    unregisterRuntimeTools();
  });

  it('returns tool definitions in stable name order', () => {
    registerMcpTools([new TestTool('zeta_tool'), new TestTool('alpha_tool')]);

    const names = getToolDefinitions().map((tool) => tool.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names.indexOf('alpha_tool')).toBeLessThan(names.indexOf('zeta_tool'));
  });

  it('registers runtime tools and filters definitions and execution', async () => {
    registerRuntimeTool(new TestTool('runtime_allowed'));
    registerRuntimeTool(new TestTool('runtime_blocked'));

    const filtered = getToolDefinitions((name) => name === 'runtime_allowed');

    expect(filtered.map((tool) => tool.name)).toEqual(['runtime_allowed']);
    await expect(
      executeTool('runtime_allowed', { file_path: 'README.md' }, undefined, (name) => name === 'runtime_allowed'),
    ).resolves.toBe('ok');
    await expect(
      executeTool('runtime_blocked', { file_path: 'README.md' }, undefined, (name) => name === 'runtime_allowed'),
    ).resolves.toContain('不在当前 agent 的允许工具范围内');
  });

  // read-only 语义直接决定 runtime turn 级 retry 是否可重放（非只读工具调用
  // 之后不能盲目重放请求），漏标会导致重放副作用。这里锁死内置工具全集。
  describe('builtin read-only semantics', () => {
    it('marks pure inspection tools as read-only', () => {
      for (const name of [
        'read_file',
        'read_image',
        'list_files',
        'grep_search',
        'web_fetch',
        'web_search',
        'Skill',
        'background_tasks',
        'read_task_output',
      ]) {
        expect(isToolReadOnly(name), `${name} should be read-only`).toBe(true);
      }
    });

    it('marks mutating/executing tools as non-read-only', () => {
      for (const name of [
        'write_file',
        'apply_patch',
        'run_shell',
        'kill_task',
        'pty_spawn',
        'pty_send',
        'pty_read',
        'pty_wait',
        'pty_kill',
      ]) {
        expect(isToolReadOnly(name), `${name} must NOT be read-only`).toBe(false);
      }
    });

    it('exposes primaryAgentOnly metadata for the todo tool', () => {
      // TodoWrite 由插件注册为 runtime tool（primaryAgentOnly），内置 registry
      // 中不存在；这里验证未知工具不误报 primaryAgentOnly。
      expect(isToolPrimaryAgentOnly('TodoWrite')).toBe(false);
    });
  });
});

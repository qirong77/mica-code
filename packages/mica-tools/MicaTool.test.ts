import { describe, expect, it, afterEach } from 'vitest';
import { MicaTool } from './MicaTool.js';
import { getToolDefinitions, registerMcpTools, unregisterMcpTools } from './registry.js';

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
  });

  it('returns tool definitions in stable name order', () => {
    registerMcpTools([new TestTool('zeta_tool'), new TestTool('alpha_tool')]);

    const names = getToolDefinitions().map((tool) => tool.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names.indexOf('alpha_tool')).toBeLessThan(names.indexOf('zeta_tool'));
  });
});

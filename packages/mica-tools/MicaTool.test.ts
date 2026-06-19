import { describe, expect, it } from 'vitest';
import { MicaTool } from './MicaTool.js';

class TestTool extends MicaTool {
  constructor() {
    super('test_tool', 'test tool', {
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

import { describe, expect, it, vi } from 'vitest';
import { ContextHandoffTool } from './Tool.js';
import { createCheckpoint, parseSet, sanitizeCheckpoint, type CheckpointInput } from './state.js';

describe('context_handoff tool boundary', () => {
  it('passes captured context for read/set/clear and returns historical labels', async () => {
    const context = {};
    const read = vi.fn(() => undefined);
    const clear = vi.fn();
    const set = vi.fn((input: CheckpointInput, _context?: unknown) => createCheckpoint(input, 'trusted-session'));
    const tool = new ContextHandoffTool({ read, clear, set });
    const result = await tool.execute({ action: 'set', checkpoint: 'historical' }, { context } as never);
    expect(set.mock.calls[0]?.[1]).toBe(context);
    expect(JSON.parse(result)).toMatchObject({ source: 'historical-model-report', sourceSessionId: 'trusted-session' });
    await tool.execute({ action: 'read' }, { context } as never);
    expect(read).toHaveBeenCalledWith(context);
    await tool.execute({ action: 'clear' }, { context } as never);
    expect(clear).toHaveBeenCalledWith(context);
  });
  it('refuses oversized multibyte payloads and never truncates valid saved content', () => {
    const checkpoint = '中'.repeat(3000);
    const valid = parseSet({ checkpoint, pending: Array(10).fill('中'.repeat(600)) });
    expect(sanitizeCheckpoint(createCheckpoint(valid, 'session'))?.checkpoint).toBe(checkpoint);
    expect(() =>
      parseSet({ checkpoint, completed: Array(16).fill('中'.repeat(600)), pending: Array(16).fill('中'.repeat(600)) }),
    ).toThrow('48 KiB');
  });
  it('cannot supply timestamps, revisions or session identities through set', () => {
    const tool = new ContextHandoffTool({ read: () => undefined, clear: vi.fn(), set: vi.fn() });
    for (const field of ['savedAt', 'revision', 'sourceSessionId', 'dismissedRevision']) {
      expect(tool.validateInput({ action: 'set', checkpoint: 'x', [field]: 'forged' }).valid).toBe(false);
    }
  });
});

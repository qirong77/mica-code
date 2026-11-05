import { describe, expect, it, vi } from 'vitest';
import { TaskDeliveryTool, type DeliveryAccess } from './Tool.js';
import { createDelivery, parseSet, sanitizeDelivery, type DeliveryInput } from './state.js';

describe('task_delivery tool boundary', () => {
  it('propagates owner context through read/set/clear without accepting caller metadata', async () => {
    const context = {};
    const read = vi.fn(() => undefined);
    const clear = vi.fn();
    const set = vi.fn((input: DeliveryInput, _context?: unknown) => createDelivery(input, 'trusted-session', []));
    const tool = new TaskDeliveryTool({ read, clear, set });
    await tool.execute({ action: 'read' }, { context } as never);
    expect(read).toHaveBeenCalledWith(context);
    await tool.execute({ action: 'set', summary: 'delivery' }, { context } as never);
    expect(set.mock.calls[0]?.[1]).toBe(context);
    await tool.execute({ action: 'clear' }, { context } as never);
    expect(clear).toHaveBeenCalledWith(context);
    expect(tool.validateInput({ action: 'set', summary: 'x', sourceSessionId: 'forged' }).valid).toBe(false);
  });
  it('enforces byte quota for multibyte input and preserves all valid content', () => {
    const valid = { action: 'set', summary: '中'.repeat(3000), changedFiles: Array(10).fill('中'.repeat(300)) };
    const parsed = parseSet(valid);
    const delivery = createDelivery(parsed, 'session', []);
    expect(sanitizeDelivery(delivery)?.summary).toBe(valid.summary);
    expect(() =>
      parseSet({
        ...valid,
        changedFiles: Array(40).fill('中'.repeat(300)),
        validationClaims: Array(12).fill('中'.repeat(600)),
      }),
    ).toThrow('48 KiB');
  });
  it('never accepts VERIFIED status or supplied proof and reports failure without error content', async () => {
    const failure = vi.fn();
    const tool = new TaskDeliveryTool({
      read: () => undefined,
      clear: vi.fn(),
      set: vi.fn(),
      failure,
    } as DeliveryAccess);
    await expect(tool.execute({ action: 'set', summary: 'x', verified: true })).rejects.toThrow();
    expect(failure).toHaveBeenCalledWith();
    expect(
      tool.validateInput({
        action: 'set',
        summary: 'x',
        reports: { code: 'done', validation: 'VERIFIED', build: 'done', deploy: 'done' },
      }).valid,
    ).toBe(false);
  });
});

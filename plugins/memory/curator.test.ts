import { describe, expect, it } from 'vitest';
import {
  MAX_CONVERSATION_CHARS,
  applyCuratorOperations,
  buildCuratorUserPrompt,
  formatConversation,
  parseCuratorOutput,
} from './curator.js';
import type { MemoryApplyResult, MemoryOperation, MemoryStoreSnapshot, MemoryTarget } from './store.js';

function snapshot(overrides: Partial<MemoryStoreSnapshot> = {}): MemoryStoreSnapshot {
  return {
    target: 'memory',
    path: '/home/.mica/memory/MEMORY.md',
    label: 'memory/MEMORY.md',
    entries: ['项目用 bun 跑测试'],
    chars: 8,
    limit: 2200,
    projectDir: null,
    ...overrides,
  };
}

describe('buildCuratorUserPrompt', () => {
  it('includes every store with usage and the recent conversation', () => {
    const prompt = buildCuratorUserPrompt({
      snapshots: [
        snapshot({ target: 'user', entries: ['用户偏好中文'], chars: 6, limit: 1375 }),
        snapshot({ target: 'project', entries: [], chars: 0, projectDir: '/repo/mica' }),
      ],
      messages: [
        { role: 'user', content: '以后测试都用 bun run test' },
        { role: 'assistant', content: '好的，已记住。' },
      ],
    });

    expect(prompt).toContain('### user · 用户档案 · 6/1375 字符');
    expect(prompt).toContain('- 用户偏好中文');
    expect(prompt).toContain('### project · 项目记忆 · 0/2200 字符 · 目录 /repo/mica');
    expect(prompt).toContain('user: 以后测试都用 bun run test');
    expect(prompt).toContain('assistant: 好的，已记住。');
    expect(prompt).toContain('{"operations":[]}');
  });
});

describe('formatConversation', () => {
  it('keeps the most recent messages when the excerpt is too long', () => {
    const messages = Array.from({ length: 10 }, (_value, index) => ({
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `${index}: ${'x'.repeat(3000)}`,
    }));

    const text = formatConversation(messages);

    expect(text.length).toBeLessThanOrEqual(MAX_CONVERSATION_CHARS + 100);
    expect(text).toContain('9: ');
    expect(text).not.toContain('0: ');
  });

  it('returns a placeholder for an empty conversation', () => {
    expect(formatConversation([])).toBe('（空）');
  });
});

describe('parseCuratorOutput', () => {
  it('parses plain JSON and keeps every valid operation', () => {
    const result = parseCuratorOutput(
      JSON.stringify({
        operations: [
          { target: 'user', action: 'add', content: '用户偏好简短回答' },
          { target: 'memory', action: 'patch', old_text: 'bun', content: 'bun run test' },
          { target: 'project', action: 'remove', old_text: '过时的一条' },
        ],
      }),
    );

    expect(result).toEqual({
      ok: true,
      skipped: 0,
      operations: [
        { target: 'user', action: 'add', content: '用户偏好简短回答' },
        { target: 'memory', action: 'patch', old_text: 'bun', content: 'bun run test' },
        { target: 'project', action: 'remove', old_text: '过时的一条' },
      ],
    });
  });

  it('extracts JSON from a fenced block with surrounding prose', () => {
    const result = parseCuratorOutput(
      '以下是操作：\n```json\n{"operations":[{"target":"memory","action":"add","content":"记住这个"}]}\n```\n完成。',
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.operations).toHaveLength(1);
  });

  it('skips malformed operations instead of failing the whole batch', () => {
    const result = parseCuratorOutput(
      JSON.stringify({
        operations: [
          { target: 'nope', action: 'add', content: 'x' },
          { target: 'memory', action: 'add' },
          { target: 'memory', action: 'replace', content: 'x' },
          { target: 'memory', action: 'add', content: '有效的' },
        ],
      }),
    );

    expect(result).toEqual({
      ok: true,
      skipped: 3,
      operations: [{ target: 'memory', action: 'add', content: '有效的' }],
    });
  });

  it('reports a clear error when the response cannot be used', () => {
    expect(parseCuratorOutput('')).toMatchObject({ ok: false, error: expect.stringContaining('empty') });
    expect(parseCuratorOutput('没有 JSON')).toMatchObject({ ok: false, error: expect.stringContaining('no JSON') });
    expect(parseCuratorOutput('{"ops":[]}')).toMatchObject({
      ok: false,
      error: expect.stringContaining('operations array'),
    });
    expect(parseCuratorOutput('{not json}')).toMatchObject({ ok: false, error: expect.stringContaining('not valid') });
  });

  it('fails instead of reporting "nothing to save" when every operation was unusable', () => {
    // 真实模型会退回 Codex 风格的 schema；静默当成空操作会让用户以为整理器工作了。
    const result = parseCuratorOutput(
      JSON.stringify({ operations: [{ op: 'add', path: '/repo/demo', value: '测试用 bun' }] }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('unsupported shape');
      expect(result.raw).toContain('测试用 bun');
    }
  });

  it('accepts the field aliases models drift into', () => {
    const result = parseCuratorOutput(
      JSON.stringify({
        operations: [
          { target: 'memory', op: 'add', value: '环境是 macOS' },
          { target: 'user', op: 'patch', oldText: '偏好英文', value: '偏好中文' },
          { target: 'project', op: 'remove', match: '过时的约定' },
        ],
      }),
    );

    expect(result).toEqual({
      ok: true,
      skipped: 0,
      operations: [
        { target: 'memory', action: 'add', content: '环境是 macOS' },
        { target: 'user', action: 'patch', old_text: '偏好英文', content: '偏好中文' },
        { target: 'project', action: 'remove', old_text: '过时的约定' },
      ],
    });
  });

  it('still reports an empty operation list as a successful no-op', () => {
    expect(parseCuratorOutput('{"operations":[]}')).toEqual({ ok: true, operations: [], skipped: 0 });
  });
});

describe('applyCuratorOperations', () => {
  function createApplier(failTargets: MemoryTarget[] = []) {
    const applied: { target: MemoryTarget; operations: MemoryOperation[] }[] = [];
    const applier = {
      apply(target: MemoryTarget, operations: MemoryOperation[]): MemoryApplyResult {
        applied.push({ target, operations });
        if (failTargets.includes(target)) {
          return {
            ok: false,
            error: { kind: 'budget', message: `${target} is full`, overflow: 10 },
          };
        }
        return { ok: true, store: snapshot({ target }), applied: operations.map(() => 'ok') };
      },
    };
    return { applier, applied };
  }

  it('groups operations by store and counts what was written', () => {
    const { applier, applied } = createApplier();

    const outcome = applyCuratorOperations(applier, [
      { target: 'user', action: 'add', content: 'a' },
      { target: 'memory', action: 'add', content: 'b' },
      { target: 'user', action: 'remove', old_text: 'c' },
    ]);

    expect(outcome).toEqual({ applied: 3, failures: [] });
    expect(applied).toEqual([
      {
        target: 'user',
        operations: [
          { action: 'add', content: 'a' },
          { action: 'remove', old_text: 'c' },
        ],
      },
      { target: 'memory', operations: [{ action: 'add', content: 'b' }] },
    ]);
  });

  it('keeps other stores working when one store rejects the batch', () => {
    const { applier } = createApplier(['memory']);

    const outcome = applyCuratorOperations(applier, [
      { target: 'memory', action: 'add', content: 'b' },
      { target: 'user', action: 'add', content: 'a' },
    ]);

    expect(outcome.applied).toBe(1);
    expect(outcome.failures).toEqual([{ target: 'memory', message: 'memory is full' }]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  CURATOR_SYSTEM_PROMPT,
  MAX_CONVERSATION_CHARS,
  applyCuratorOperations,
  buildCuratorUserPrompt,
  formatConversation,
  parseCuratorNotes,
  parseCuratorOutput,
  type CuratorOperation,
} from './curator.js';
import type { MemoryScope } from './scope.js';
import type { RepoIdentity } from './repo.js';
import type { DomainDefinition } from './domains.js';
import type { MemoryApplyResult, MemoryOperation } from './store.js';

const repo: RepoIdentity = {
  slug: 'mica-code-abcdef12',
  name: 'mica-code',
  root: '/repo/mica-code',
  key: 'git.example.com/team/mica-code',
  remote: 'git.example.com/team/mica-code',
  source: 'git',
};
const projectScope: MemoryScope = { kind: 'project', repo };
const zuche: DomainDefinition = {
  name: '租车',
  path: '/memory/domains/租车.md',
  match: ['/repo/sass'],
  description: null,
};
const domainScope: MemoryScope = { kind: 'domain', domain: zuche };

function snapshot(scope: MemoryScope, entries: string[] = []) {
  return {
    scope,
    key: 'k',
    title:
      scope.kind === 'profile' ? '用户档案' : scope.kind === 'project' ? '项目记忆 · mica-code' : '领域记忆 · 租车',
    path: '/tmp/x.md',
    label: 'x.md',
    entries,
    chars: entries.join('\n\n').length,
    budget: 1200,
  };
}

describe('CURATOR_SYSTEM_PROMPT', () => {
  it('states the three tests that gate writing', () => {
    expect(CURATOR_SYSTEM_PROMPT).toContain('三个月后');
    expect(CURATOR_SYSTEM_PROMPT).toContain('脱离本次对话');
    expect(CURATOR_SYSTEM_PROMPT).toContain('事实还是规则');
  });

  it('forbids profile writes', () => {
    expect(CURATOR_SYSTEM_PROMPT).toContain('不允许');
    expect(CURATOR_SYSTEM_PROMPT).toContain('profile');
  });

  it('names the rules that must not be stored as memory', () => {
    for (const rule of ['必须复用', '改完要跑', '不要用']) {
      expect(CURATOR_SYSTEM_PROMPT).toContain(rule);
    }
  });

  it('says an empty result is the normal outcome', () => {
    expect(CURATOR_SYSTEM_PROMPT).toContain('空操作');
  });
});

describe('buildCuratorUserPrompt', () => {
  it('lists the applicable scopes with their usage', () => {
    const prompt = buildCuratorUserPrompt({
      snapshots: [snapshot({ kind: 'profile' }, ['用户常用中文']), snapshot(projectScope, ['测试用 bun run test'])],
      context: '当前仓库：mica-code',
      messages: [{ role: 'user', content: '跑一下测试' }],
    });

    expect(prompt).toContain('<context>');
    expect(prompt).toContain('当前仓库：mica-code');
    expect(prompt).toContain('project · 项目记忆 · mica-code');
    expect(prompt).toContain('- 测试用 bun run test');
    expect(prompt).toContain('用户档案');
    expect(prompt).toContain('- 用户常用中文');
  });

  it('tells the curator which domains are usable and that none is usable otherwise', () => {
    const withDomain = buildCuratorUserPrompt({
      snapshots: [snapshot(domainScope)],
      context: 'x',
      messages: [],
    });
    expect(withDomain).toContain('可用的领域：租车');

    const withoutDomain = buildCuratorUserPrompt({
      snapshots: [snapshot(projectScope)],
      context: 'x',
      messages: [],
    });
    expect(withoutDomain).toContain('当前没有可用的领域');
    expect(withoutDomain).toContain('domain 类操作会被拒绝');
  });

  it('repeats the schema next to the generation point', () => {
    const prompt = buildCuratorUserPrompt({ snapshots: [], context: 'x', messages: [] });
    expect(prompt).toContain('不要 op / path / value / target / store');
    expect(prompt).toContain('{"operations":[{"scope":"project","action":"add","content":"..."}');
  });
});

describe('formatConversation', () => {
  it('keeps the most recent messages when the budget runs out', () => {
    const messages = [
      { role: 'user' as const, content: 'a'.repeat(MAX_CONVERSATION_CHARS) },
      { role: 'assistant' as const, content: '最近这句' },
    ];

    const text = formatConversation(messages);

    expect(text).toContain('最近这句');
    expect(text.length).toBeLessThanOrEqual(MAX_CONVERSATION_CHARS + 40);
  });

  it('marks an empty conversation instead of returning an empty block', () => {
    expect(formatConversation([])).toBe('（空）');
    expect(formatConversation([{ role: 'user', content: '   ' }])).toBe('（空）');
  });
});

describe('parseCuratorOutput', () => {
  it('accepts a bare JSON object', () => {
    const result = parseCuratorOutput('{"operations":[{"scope":"project","action":"add","content":"用 bun"}]}');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.operations).toEqual([{ scope: 'project', action: 'add', content: '用 bun' }]);
    }
  });

  it('strips a markdown code fence and surrounding prose', () => {
    const result = parseCuratorOutput('以下是操作：\n```json\n{"operations":[]}\n```\n希望有帮助');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.operations).toEqual([]);
  });

  it('carries the domain for domain operations', () => {
    const result = parseCuratorOutput(
      '{"operations":[{"scope":"domain","domain":"租车","action":"add","content":"灰度走 sass 发布台"}]}',
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.operations[0]?.domain).toBe('租车');
  });

  it('recognises aliases models fall back to', () => {
    const result = parseCuratorOutput(
      JSON.stringify({
        operations: [
          { target: 'repo', op: 'add', value: '项目用 pnpm' },
          { store: 'user', action: 'add', text: '用户偏好中文' },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.operations.map((operation) => operation.scope)).toEqual(['project', 'profile']);
      expect(result.operations[0]?.content).toBe('项目用 pnpm');
    }
  });

  it('rejects an answer in an unsupported shape instead of silently doing nothing', () => {
    const result = parseCuratorOutput('{"operations":[{"op":"create","path":"notes.md","value":"x"}]}');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unsupported shape');
  });

  it('reports invalid JSON and missing arrays', () => {
    expect(parseCuratorOutput('').ok).toBe(false);
    expect(parseCuratorOutput('没有 JSON').ok).toBe(false);
    const notJson = parseCuratorOutput('{"operations": [oops]}');
    expect(notJson.ok).toBe(false);
    if (!notJson.ok) expect(notJson.error).toContain('not valid JSON');
    const missing = parseCuratorOutput('{"ops":[]}');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('operations array');
  });

  it('caps the number of operations per run', () => {
    const operations = Array.from({ length: 30 }, (_, index) => ({
      scope: 'project',
      action: 'add',
      content: `条目 ${index}`,
    }));

    const result = parseCuratorOutput(JSON.stringify({ operations }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.operations).toHaveLength(10);
      expect(result.skipped).toBe(20);
    }
  });

  it('requires old_text for patch and remove', () => {
    const result = parseCuratorOutput(
      JSON.stringify({
        operations: [
          { scope: 'project', action: 'patch', content: '新内容' },
          { scope: 'project', action: 'remove' },
          { scope: 'project', action: 'add', content: '有效的一条' },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.operations).toHaveLength(1);
      expect(result.skipped).toBe(2);
    }
  });

  it('reads the optional notes field', () => {
    expect(parseCuratorNotes('{"operations":[],"notes":"用户似乎偏好中文"}')).toBe('用户似乎偏好中文');
    expect(parseCuratorNotes('{"operations":[]}')).toBeNull();
    expect(parseCuratorNotes('not json')).toBeNull();
  });
});

describe('applyCuratorOperations', () => {
  function createApplier() {
    const calls: { scope: MemoryScope; operations: MemoryOperation[] }[] = [];
    const result: MemoryApplyResult = { ok: true, store: {} as never, applied: [] };
    return {
      calls,
      applier: {
        apply: vi.fn((scope: MemoryScope, operations: MemoryOperation[]) => {
          calls.push({ scope, operations });
          return result;
        }),
      },
    };
  }

  const resolver = (operation: CuratorOperation) => {
    if (operation.scope === 'project') return { ok: true as const, scope: projectScope };
    if (operation.scope === 'domain' && operation.domain === '租车') return { ok: true as const, scope: domainScope };
    return { ok: false as const, error: `领域「${operation.domain ?? ''}」不存在` };
  };

  it('writes one atomic batch per scope', () => {
    const { applier, calls } = createApplier();

    const outcome = applyCuratorOperations(applier, resolver, [
      { scope: 'project', action: 'add', content: 'a' },
      { scope: 'domain', domain: '租车', action: 'add', content: 'b' },
      { scope: 'project', action: 'add', content: 'c' },
    ]);

    expect(outcome.applied).toBe(3);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.operations).toHaveLength(2);
    expect(calls[1]?.scope.kind).toBe('domain');
  });

  it('never writes profile from the curator', () => {
    const { applier } = createApplier();

    const outcome = applyCuratorOperations(applier, resolver, [
      { scope: 'profile', action: 'add', content: '用户偏好中文' },
    ]);

    expect(outcome.applied).toBe(0);
    expect(outcome.failures[0]?.scope).toBe('profile');
    expect(outcome.failures[0]?.message).toContain('profile');
  });

  it('reports an unknown domain without writing it', () => {
    const { applier, calls } = createApplier();

    const outcome = applyCuratorOperations(applier, resolver, [
      { scope: 'domain', domain: '不存在的领域', action: 'add', content: 'x' },
    ]);

    expect(calls).toHaveLength(0);
    expect(outcome.failures[0]?.message).toContain('不存在');
  });

  it('keeps the successful scope when another scope fails', () => {
    const applier = {
      apply: vi.fn(
        (scope: MemoryScope): MemoryApplyResult =>
          scope.kind === 'domain'
            ? { ok: false, error: { kind: 'unavailable', message: '锁住了' } }
            : { ok: true, store: {} as never, applied: [] },
      ),
    };

    const outcome = applyCuratorOperations(applier, resolver, [
      { scope: 'project', action: 'add', content: 'a' },
      { scope: 'domain', domain: '租车', action: 'add', content: 'b' },
    ]);

    expect(outcome.applied).toBe(1);
    expect(outcome.failures).toEqual([{ scope: 'domain', message: '锁住了' }]);
  });
});

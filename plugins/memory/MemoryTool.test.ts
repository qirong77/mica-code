import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryTool, parseMemoryInput } from './MemoryTool.js';
import { MemoryRepository } from './store.js';

const tempDirs: string[] = [];

function createTool(options: { memoryLimit?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mica-memory-tool-'));
  tempDirs.push(dir);
  const repository = new MemoryRepository({
    rootDir: dir,
    budgets: { user: 1375, memory: options.memoryLimit ?? 2200, project: 2200 },
    resolveProjectDir: () => '/repo/mica',
  });
  return { repository, tool: new MemoryTool(repository) };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseMemoryInput', () => {
  it('accepts a read request without operations', () => {
    expect(parseMemoryInput({ target: 'user' })).toEqual({ ok: true, target: 'user', operations: [] });
  });

  it('rejects unknown targets and fields', () => {
    expect(parseMemoryInput({ target: 'nope' }).ok).toBe(false);
    expect(parseMemoryInput({ target: 'user', extra: 1 }).ok).toBe(false);
    expect(parseMemoryInput({ target: 'user', operations: [{ action: 'add', content: 'x', extra: 1 }] }).ok).toBe(
      false,
    );
  });

  it('requires content for add and old_text for patch / remove', () => {
    expect(parseMemoryInput({ target: 'user', operations: [{ action: 'add' }] }).ok).toBe(false);
    expect(parseMemoryInput({ target: 'user', operations: [{ action: 'patch', content: 'x' }] }).ok).toBe(false);
    expect(parseMemoryInput({ target: 'user', operations: [{ action: 'remove', old_text: '  ' }] }).ok).toBe(false);
  });

  it('rejects more operations than one call may carry', () => {
    const operations = Array.from({ length: 11 }, () => ({ action: 'add', content: 'x' }));
    expect(parseMemoryInput({ target: 'user', operations }).ok).toBe(false);
  });
});

describe('MemoryTool', () => {
  it('reads the store and shows usage', async () => {
    const { repository, tool } = createTool();
    repository.apply('memory', [{ action: 'add', content: '项目用 bun' }]);

    const output = await tool.execute({ target: 'memory' });

    // 工具结果与其它工具一致用英文：模型读的和它读工具描述的语言是同一套。
    expect(output).toContain('memory · 1 entries');
    expect(output).toContain('1. 项目用 bun');
  });

  it('writes an entry and explains when it becomes visible', async () => {
    const { repository, tool } = createTool();

    const output = await tool.execute({
      target: 'user',
      operations: [{ action: 'add', content: '用户偏好中文回复' }],
    });

    expect(output).toContain('Memory updated (user)');
    expect(output).toContain('added 1 entry');
    expect(output).toContain('/memory refresh');
    expect(repository.read('user')).toEqual(['用户偏好中文回复']);
  });

  it('returns actionable guidance when the budget is full', async () => {
    const { tool } = createTool({ memoryLimit: 40 });

    await expect(
      tool.execute({ target: 'memory', operations: [{ action: 'add', content: 'x'.repeat(50) }] }),
    ).rejects.toThrow(/Free at least \d+ characters/);
  });

  it('lists candidates when old_text does not match', async () => {
    const { repository, tool } = createTool();
    repository.apply('memory', [{ action: 'add', content: '已有的一条' }]);

    await expect(
      tool.execute({ target: 'memory', operations: [{ action: 'remove', old_text: '不存在' }] }),
    ).rejects.toThrow(/Candidates:[\s\S]*已有的一条/);
  });

  it('describes the tool call in one line', () => {
    const { tool } = createTool();

    expect(tool.onToolUseDisplayText({ target: 'memory' })).toBe('Reviewing memory (memory)');
    expect(tool.onToolUseDisplayText({ target: 'user', operations: [{ action: 'add' }, { action: 'patch' }] })).toBe(
      'Saving memory (user, add, patch)',
    );
  });
});

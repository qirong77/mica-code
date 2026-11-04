import { describe, expect, it } from 'vitest';
import { MAX_SESSION_NOTES_LENGTH } from '@packages/mica-common/index.js';
import { SessionNotesTool, parseNotesInput } from './NotesTool.js';

function createTool(initial = '') {
  let notes = initial;
  const tool = new SessionNotesTool(
    () => notes,
    (next) => {
      notes = next;
    },
  );
  return { tool, notes: () => notes };
}

describe('parseNotesInput', () => {
  it('accepts read without content', () => {
    expect(parseNotesInput({ action: 'read' })).toEqual({ ok: true, action: 'read' });
  });

  it('requires content for append and replace', () => {
    expect(parseNotesInput({ action: 'append' })).toEqual({
      ok: false,
      message: 'append requires content to be a string',
    });
    expect(parseNotesInput({ action: 'append', content: '   ' })).toEqual({
      ok: false,
      message: 'append requires non-empty content',
    });
  });

  it('rejects unknown actions and fields instead of silently ignoring them', () => {
    expect(parseNotesInput({ action: 'delete' })).toEqual({
      ok: false,
      message: 'action must be read, append, replace, replace_section, or remove_section',
    });
    expect(parseNotesInput({ action: 'read', body: 'x' })).toEqual({
      ok: false,
      message: 'unknown input field: body',
    });
  });

  it('rejects content beyond the limit so the prompt cannot grow unbounded', () => {
    const parsed = parseNotesInput({
      action: 'replace',
      content: 'x'.repeat(MAX_SESSION_NOTES_LENGTH + 1),
    });
    expect(parsed.ok).toBe(false);
  });
});

describe('SessionNotesTool', () => {
  it('reports an empty document on read', async () => {
    const { tool } = createTool();
    expect(await tool.execute({ action: 'read' })).toBe('Session notes are empty.');
  });

  it('returns the current markdown on read', async () => {
    const { tool } = createTool('# 决策\n用 Bun');
    expect(await tool.execute({ action: 'read' })).toBe('# 决策\n用 Bun');
  });

  it('appends below the existing notes and reports the new size', async () => {
    const { tool, notes } = createTool('# 决策');
    const result = await tool.execute({ action: 'append', content: '- 用 Bun 跑测试' });
    expect(notes()).toBe('# 决策\n\n- 用 Bun 跑测试');
    expect(result).toContain('now 17 characters, 3 lines');
    // 说明生效时机：笔记在下一轮的 system prompt 才带上，模型不必为此再读一次。
    expect(result).toContain('next turn');
  });

  it('rejects an append that would overflow instead of truncating the tail in silence', async () => {
    const { tool, notes } = createTool('x'.repeat(MAX_SESSION_NOTES_LENGTH - 10));
    await expect(tool.execute({ action: 'append', content: 'y'.repeat(50) })).rejects.toThrow(/over the 20000 limit/);
    // 拒绝就真的不写：不能留下被截断的半截笔记。
    expect(notes()).toBe('x'.repeat(MAX_SESSION_NOTES_LENGTH - 10));
  });

  it('replaces the whole document', async () => {
    const { tool, notes } = createTool('# 旧内容\n- a');
    const result = await tool.execute({ action: 'replace', content: '# 新内容' });
    expect(notes()).toBe('# 新内容');
    expect(result).toBe('Session notes replaced: now 5 characters, 1 lines.');
  });

  it('clears obsolete notes with an empty replacement', async () => {
    const { tool, notes } = createTool('# 已失效的约束');

    await tool.execute({ action: 'replace', content: '' });

    expect(notes()).toBe('');
    await expect(tool.execute({ action: 'read' })).resolves.toBe('Session notes are empty.');
  });

  it('normalizes trailing whitespace so an unchanged save is not seen as an edit', async () => {
    const { tool, notes } = createTool();
    await tool.execute({ action: 'replace', content: 'line   \n\n\n' });
    expect(notes()).toBe('line');
  });

  it('throws on invalid input rather than writing', async () => {
    const { tool, notes } = createTool('# 保留');
    await expect(tool.execute({ action: 'append' })).rejects.toThrow('append requires content to be a string');
    expect(notes()).toBe('# 保留');
  });

  it('describes read and write turns differently in the transcript', () => {
    const { tool } = createTool();
    expect(tool.onToolUseDisplayText({ action: 'read' })).toBe('Reading session notes');
    expect(tool.onToolUseDisplayText({ action: 'append' })).toBe('Updating session notes (append)');
  });

  it('is a write tool so it forms a serial barrier between read-only batches', () => {
    const { tool } = createTool();
    expect(tool.readOnly).toBe(false);
    expect(tool.name).toBe('session_notes');
  });
});

describe('session notes section editing', () => {
  const notes = ['# 约束', '- 不建分支', '', '## 路径', '- 配置在 ~/.mica', '', '# 已失效', '- 旧的结论'].join('\n');

  it('removes one section and keeps the rest byte-for-byte', async () => {
    const { tool, notes: read } = createTool(notes);
    const result = await tool.execute({ action: 'remove_section', section: '已失效' });
    expect(read()).toBe('# 约束\n- 不建分支\n\n## 路径\n- 配置在 ~/.mica');
    expect(result).toContain('section removed ("已失效")');
    expect(result).toContain('next turn');
  });

  it('replaces only the body of the named heading', async () => {
    const { tool, notes: read } = createTool(notes);
    await tool.execute({ action: 'replace_section', section: '## 路径', content: '- 配置在 $MICA_HOME' });
    expect(read()).toBe('# 约束\n- 不建分支\n\n## 路径\n- 配置在 $MICA_HOME\n\n# 已失效\n- 旧的结论');
  });

  it('keeps a nested subsection inside its parent when the parent is removed', async () => {
    const { tool, notes: read } = createTool(notes);
    await tool.execute({ action: 'remove_section', section: '约束' });
    // `## 路径` 是 `# 约束` 的下一级，跟着父节一起删掉；同级及更高级的 `# 已失效` 保留。
    expect(read()).toBe('# 已失效\n- 旧的结论');
  });

  it('names the existing headings instead of guessing when the title is wrong', async () => {
    const { tool } = createTool(notes);
    await expect(tool.execute({ action: 'remove_section', section: '不存在' })).rejects.toThrow(
      /no section titled "不存在"; existing sections: # 约束 \| ## 路径 \| # 已失效/,
    );
  });

  it('refuses an ambiguous title rather than deleting the wrong section', async () => {
    const { tool, notes: read } = createTool('# 说明\na\n\n# 说明\nb');
    await expect(tool.execute({ action: 'remove_section', section: '说明' })).rejects.toThrow(
      /matches 2 headings \(line 1, line 4\)/,
    );
    expect(read()).toBe('# 说明\na\n\n# 说明\nb');
  });

  it('does not treat a comment inside a fenced block as a heading', async () => {
    const { tool, notes: read } = createTool(['# 命令', '```sh', '# 这不是标题', 'make build', '```'].join('\n'));
    await expect(tool.execute({ action: 'remove_section', section: '这不是标题' })).rejects.toThrow(
      /existing sections: # 命令/,
    );
    expect(read()).toContain('# 这不是标题');
  });

  // 真实触发场景：笔记已经顶到上限，append 被拒。以前只有「整篇重写」一条出路。
  it('frees room at the length limit without rewriting the whole document', async () => {
    const filler = 'x'.repeat(MAX_SESSION_NOTES_LENGTH - 200);
    const { tool, notes: read } = createTool(`# 陈旧\n${filler}\n\n# 新内容\n- a`);
    await expect(tool.execute({ action: 'append', content: 'y'.repeat(400) })).rejects.toThrow(/over the 20000 limit/);

    const removed = await tool.execute({ action: 'remove_section', section: '陈旧' });
    expect(removed).toContain('section removed ("陈旧")');
    expect(read().length).toBeLessThan(200);
    // 腾出空间之后，同一次操作序列里的 append 才能成功。
    await tool.execute({ action: 'append', content: 'y'.repeat(400) });
    expect(read()).toContain('y'.repeat(400));
  });

  it('still refuses a section replacement that would overflow', async () => {
    const { tool, notes: read } = createTool(`# 大段\n${'x'.repeat(MAX_SESSION_NOTES_LENGTH - 100)}\n\n# 小段\n- a`);
    await expect(
      tool.execute({ action: 'replace_section', section: '小段', content: 'y'.repeat(200) }),
    ).rejects.toThrow(/over the 20000 limit/);
    expect(read()).toContain('x'.repeat(100));
    // 拒绝就真的不写：小段还是原来的内容。
    expect(read()).toContain('# 小段\n- a');
  });

  it('rejects a section argument on the whole-document actions', () => {
    expect(parseNotesInput({ action: 'replace', content: 'x', section: '记' })).toEqual({
      ok: false,
      message: 'section is only valid for replace_section / remove_section, not replace',
    });
    expect(parseNotesInput({ action: 'remove_section' })).toEqual({
      ok: false,
      message: 'remove_section requires section to name a heading',
    });
  });

  it('names the section in the transcript line', () => {
    const { tool } = createTool();
    expect(tool.onToolUseDisplayText({ action: 'remove_section', section: ' 已失效 ' })).toBe(
      'Updating session notes (remove_section "已失效")',
    );
  });
});

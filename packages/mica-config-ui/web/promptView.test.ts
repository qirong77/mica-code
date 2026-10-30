import { describe, expect, it } from 'vitest';
import { promptPartLabel, splitPromptSections, summarizePrompt } from './promptView.js';

/** 真实的拼接结果：`buildSystemPrompt()` 用 `\n\n` 连接各个 `<tag>` 段，插件段落追加在最末。 */
const SENT_PROMPT = [
  '<system>',
  'You are Mica.',
  '</system>',
  '',
  '<project-instructions>',
  '# AGENT.md',
  '',
  'Keep it small.',
  '</project-instructions>',
  '',
  '<skills>',
  '- demo: does demo things',
  '</skills>',
  '',
  '<context>',
  '# 环境信息',
  '- 当前工作目录: /tmp/project',
  '</context>',
  '',
  '## 计划',
  '先看一眼仓库再动手。',
].join('\n');

describe('splitPromptSections', () => {
  it('按顶层标签切段，标签之外的追加内容单独成段', () => {
    const parts = splitPromptSections(SENT_PROMPT);

    expect(parts.map((part) => part.tag)).toEqual(['system', 'project-instructions', 'skills', 'context', '']);
    expect(parts.map((part) => part.label)).toEqual([
      '角色提示词',
      '项目说明（AGENT.md）',
      'Skills 索引',
      '环境信息',
      '插件段落 / 其它注入',
    ]);
    // 段内换行不少一行：`<project-instructions>` 里有一段空行。
    expect(parts[1]!.chars).toBe('<project-instructions>\n# AGENT.md\n\nKeep it small.\n</project-instructions>'.length);
  });

  it('空提示词与纯空白不产生段落', () => {
    expect(splitPromptSections('')).toEqual([]);
    expect(splitPromptSections('\n\n')).toEqual([]);
  });

  it('嵌套的同名标签不会把外层截断', () => {
    const prompt = ['<system>', 'outer', '<system>inner</system>', '</system>'].join('\n');
    const parts = splitPromptSections(prompt);

    expect(parts).toHaveLength(1);
    expect(parts[0]!.tag).toBe('system');
    expect(parts[0]!.chars).toBe(prompt.length);
  });

  it('未知标签用自己的名字，不编一个中文名', () => {
    expect(promptPartLabel('harness_review')).toBe('harness_review');
    expect(promptPartLabel('')).toBe('插件段落 / 其它注入');
  });
});

describe('summarizePrompt', () => {
  it('给出字符数、粗估 tokens 与行数', () => {
    const summary = summarizePrompt('中文\nabcd');

    expect(summary.chars).toBe(7);
    expect(summary.lines).toBe(2);
    expect(summary.tokens).toBe(4); // 2 个 CJK 各 1，剩下 5 个 ASCII 折 2
    expect(summarizePrompt('')).toEqual({ chars: 0, tokens: 0, lines: 0 });
  });
});

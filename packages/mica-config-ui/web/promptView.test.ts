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
    expect(parts[1]!.chars).toBe(
      '<project-instructions>\n# AGENT.md\n\nKeep it small.\n</project-instructions>'.length,
    );
  });

  it('保留每个模块正文、重复标签和无标签内容', () => {
    const first = '<custom>\nfirst\n</custom>';
    const second = '<custom>\nsecond\n</custom>';
    const parts = splitPromptSections(`${first}\n\nplain\n\n${second}`);
    expect(parts.map((part) => part.content)).toEqual([first, '\n\nplain\n\n', second]);
    expect(parts.map((part) => part.tag)).toEqual(['custom', '', 'custom']);
  });

  it('同名多行嵌套与围栏里的标签保持在原模块中', () => {
    const prompt = '<system>\nouter\n<system>\ninner\n</system>\n```xml\n</system>\n```\n</system>';
    expect(splitPromptSections(prompt).map((part) => part.content)).toEqual([prompt]);
    const fenced = '```xml\n<example>\ntext\n</example>\n```';
    expect(splitPromptSections(fenced).map((part) => part.tag)).toEqual(['']);
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

  it('显示每次 injection 的插件和段落，保留发送内容与体积', () => {
    const first = '<injection source="plugin" plugin="requirements" section="workflow">\nplan\n</injection>';
    const second = "<injection section='notes' plugin='memory' source='plugin'>\nremember\n</injection>";
    const parts = splitPromptSections(`${first}\n\n${second}`);
    expect(parts.map((part) => part.label)).toEqual(['requirements / workflow', 'memory / notes']);
    expect(parts.map((part) => part.tag)).toEqual(['injection', 'injection']);
    expect(parts.map((part) => part.content)).toEqual([first, second]);
    expect(parts[0]!.chars).toBe(first.length);
    expect(parts[0]!.tokens).toBe(summarizePrompt(first).tokens);
  });

  it('展示时解码命名和数字 XML 实体，不递归解码或改写正文', () => {
    const prompt =
      '<injection source="plugin" plugin="A&amp;B&lt;C&gt;&quot;&apos;" section="&#65;&#x1F680; &amp;lt; &unknown; &#x110000; &#55296;">\nbody\n</injection>';
    const [part] = splitPromptSections(prompt);
    expect(part!.label).toBe('A&B<C>"\' / A🚀 &lt; &unknown; &#x110000; &#55296;');
    expect(part!.content).toBe(prompt);
  });

  it('有属性的同名嵌套及代码围栏不会截断顶层 injection', () => {
    const prompt = [
      '<injection source="plugin" plugin="outer" section="a > b">',
      '<injection plugin="inner">',
      'inner',
      '</injection>',
      '````xml',
      '</injection>',
      '```',
      '````',
      '~~~xml',
      '<injection plugin="example">',
      '</injection>',
      '~~~',
      '</injection>',
    ].join('\r\n');
    const parts = splitPromptSections(prompt);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.label).toBe('outer / a > b');
    expect(parts[0]!.content).toBe(prompt);
    expect(splitPromptSections(`~~~~xml\n${prompt}\n~~~~`)[0]!.tag).toBe('');
  });

  it('保留基础标签名称，缺少来源时回退，未闭合注入作为其它内容', () => {
    expect(splitPromptSections('<system source="role">\nrole\n</system>')[0]!.label).toBe('角色提示词');
    expect(splitPromptSections('<injection>\nbody\n</injection>')[0]!.label).toBe('injection');
    expect(splitPromptSections('<injection source="hook" section="build">\nbody\n</injection>')[0]!.label).toBe(
      'hook / build',
    );
    const incomplete = '<injection plugin="unfinished">\nbody';
    expect(splitPromptSections(incomplete)[0]).toMatchObject({ tag: '', content: incomplete });
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

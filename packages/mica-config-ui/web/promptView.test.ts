import { describe, expect, it } from 'vitest';
import {
  analyzePrompt,
  promptNodePath,
  promptPartLabel,
  promptShareWeights,
  searchPrompt,
  splitPromptSections,
  summarizePrompt,
} from './promptView.js';

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
  it('区分固定默认正文与追加的 Role，并保留系统提示词顺序', () => {
    const system = '<system>\nDefault instructions.\n</system>';
    const role = '<role>\nTranslate clearly.\n</role>';
    const parts = splitPromptSections(`${system}\n\n${role}`);
    expect(parts.map((part) => [part.tag, part.label])).toEqual([
      ['system', '系统提示词正文'],
      ['role', '追加 Role'],
    ]);
    expect(parts.map((part) => part.content)).toEqual([system, role]);
  });

  it('按顶层标签切段，标签之外的追加内容单独成段', () => {
    const parts = splitPromptSections(SENT_PROMPT);

    expect(parts.map((part) => part.tag)).toEqual(['system', 'project-instructions', 'skills', 'context', '']);
    expect(parts.map((part) => part.label)).toEqual([
      '系统提示词正文',
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
    expect(splitPromptSections('<system source="role">\nrole\n</system>')[0]!.label).toBe('系统提示词正文');
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

/** 段内既有 `#` 也有 `##`，还有一个围栏块里的假标题。 */
const NESTED_PROMPT = [
  '<system>',
  'You are Mica.',
  '</system>',
  '',
  '<project-instructions>',
  '# 手册',
  '前言一行。',
  '',
  '## 1. 工作约定',
  '约定正文。',
  '',
  '### 1.1 细节',
  '细节正文。',
  '',
  '## 2. 命令',
  '```bash',
  '# 这不是标题',
  'bun run test',
  '```',
  '</project-instructions>',
].join('\n');

describe('analyzePrompt', () => {
  it('顶层段按标签切，段内再按 markdown 标题切成树', () => {
    const nodes = analyzePrompt(NESTED_PROMPT).nodes;

    expect(nodes.map((node) => node.label)).toEqual(['系统提示词正文', '项目说明（AGENT.md）']);
    const book = nodes[1]!;
    expect(book.level).toBe(0);
    // 段里唯一的 h1 被提到段本身：段名已经说了来源，不必再点一层。
    expect(book.children.map((child) => child.label)).toEqual(['1. 工作约定', '2. 命令']);
    expect(book.children[0]!.children.map((child) => child.label)).toEqual(['1.1 细节']);
  });

  it('行号按全文算，围栏块里的 # 不当标题', () => {
    const nodes = analyzePrompt(NESTED_PROMPT).nodes;
    const book = nodes[1]!;

    expect(nodes[0]!.startLine).toBe(1);
    expect(nodes[0]!.endLine).toBe(3);
    expect(book.startLine).toBe(5);
    expect(book.endLine).toBe(20);
    const commands = book.children[1]!;
    expect(commands.label).toBe('2. 命令');
    // 围栏里的 `# 这不是标题` 留在「2. 命令」自己的正文里，没有变成子节。
    expect(commands.children).toEqual([]);
    expect(commands.content).toContain('# 这不是标题');
  });

  it('体积：节点含子节，ownChars 只算自己写的那部分', () => {
    const nodes = analyzePrompt(NESTED_PROMPT).nodes;
    const book = nodes[1]!;
    const section = book.children[0]!;
    const leaf = section.children[0]!;

    expect(book.chars).toBe(book.content.length);
    expect(book.chars).toBeGreaterThan(section.chars);
    // 父节点 = ownChars + 每个子节；叶子节点没有子节，两者相等。
    const childChars = book.children.reduce((sum, child) => sum + child.chars, 0);
    expect(book.ownChars).toBe(book.chars - childChars);
    expect(section.ownChars).toBe(section.chars - leaf.chars);
    expect(leaf.ownChars).toBe(leaf.chars);
  });

  it('重复标签与标签之外的追加内容仍然各成一段', () => {
    const prompt = '<custom>\nfirst\n</custom>\n\n插件写的一段\n\n<custom>\nsecond\n</custom>';
    const nodes = analyzePrompt(prompt).nodes;

    expect(nodes.map((node) => node.tag)).toEqual(['custom', '', 'custom']);
    expect(nodes[1]!.label).toBe('插件段落 / 其它注入');
  });

  it('空提示词没有节点', () => {
    expect(analyzePrompt('')).toEqual({ nodes: [], summary: { chars: 0, tokens: 0, lines: 0 } });
  });

  it('promptNodePath 给出从段到目标节点的链', () => {
    const nodes = analyzePrompt(NESTED_PROMPT).nodes;
    const target = nodes[1]!.children[0]!.children[0]!;

    expect(promptNodePath(nodes, target.id).map((node) => node.label)).toEqual([
      '项目说明（AGENT.md）',
      '1. 工作约定',
      '1.1 细节',
    ]);
  });
});

describe('searchPrompt', () => {
  it('按标题与正文过滤，父链保留，命中数只算节点自己的正文', () => {
    const nodes = analyzePrompt(NESTED_PROMPT).nodes;
    const result = searchPrompt(nodes, '正文。');

    expect(result.total).toBe(2);
    // 默认正文里没有这个词，整段被过滤掉；「项目说明」因为子节命中而留在树上。
    expect(result.nodes).toHaveLength(1);
    const book = result.nodes[0]!;
    expect(book.label).toBe('项目说明（AGENT.md）');
    const section = book.children[0]!;
    expect(section.label).toBe('1. 工作约定');
    expect(result.hits.get(section.id)).toBe(1);
    expect(result.hits.get(section.children[0]!.id)).toBe(1);
    // 「2. 命令」没有命中，整节被裁掉，但父段仍保留。
    expect(book.children).toHaveLength(1);
  });

  it('空查询原样返回，清空搜索不丢结构', () => {
    const nodes = analyzePrompt(NESTED_PROMPT).nodes;

    expect(searchPrompt(nodes, '   ').nodes).toBe(nodes);
    expect(searchPrompt(nodes, '').total).toBe(0);
  });

  it('没有命中时返回空树而不是整棵大纲', () => {
    const nodes = analyzePrompt(NESTED_PROMPT).nodes;

    expect(searchPrompt(nodes, '不存在的词').nodes).toEqual([]);
  });
});

describe('promptShareWeights', () => {
  it('按真实占比分配，大段不会被小段拖平', () => {
    const weights = promptShareWeights([870, 13, 117], 1000);

    expect(weights[0]).toBeCloseTo(0.87);
    expect(weights[0]! / weights[2]!).toBeCloseTo(0.87 / 0.117, 1);
  });

  it('极小的段抬到下限，否则那一段只有两三个像素、点不中', () => {
    const weights = promptShareWeights([999, 1], 1000);

    expect(weights[1]).toBeCloseTo(0.02);
  });

  it('段数很多时下限自动收窄，不把真实占比冲淡', () => {
    const sizes = Array.from({ length: 40 }, (_item, index) => (index === 0 ? 900 : 2.5));
    const weights = promptShareWeights(sizes, 1000);

    expect(weights[1]).toBeCloseTo(0.35 / 40);
    expect(weights[1]!).toBeLessThan(0.02);
  });

  it('总字符为 0 时各段等权，不会除以 0', () => {
    const weights = promptShareWeights([0, 0], 0);

    expect(weights).toEqual([0.02, 0.02]);
  });
});

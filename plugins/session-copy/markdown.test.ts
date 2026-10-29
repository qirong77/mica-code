import { describe, expect, it } from 'vitest';
import { conversationTurns, describeModel, messageText, sessionMarkdown } from './markdown.js';

describe('messageText', () => {
  it('keeps a plain string as-is', () => {
    expect(messageText('  帮我看看这个报错  ')).toBe('帮我看看这个报错');
  });

  it('joins text blocks and marks images without a path', () => {
    expect(
      messageText([
        { type: 'text', text: '第一段' },
        { type: 'image', source: 'base64-data' },
        { type: 'text', text: '第二段' },
      ]),
    ).toBe('第一段\n[图片]\n第二段');
  });

  it('ignores malformed blocks', () => {
    expect(messageText([null, 42, { type: 'text' }])).toBe('');
    expect(messageText(undefined)).toBe('');
  });
});

describe('conversationTurns', () => {
  it('drops notices (they are not part of the conversation)', () => {
    const turns = conversationTurns([
      { role: 'user', content: '问题' },
      { role: 'notice', content: '命令结果' },
      { role: 'assistant', content: '回答' },
    ]);
    expect(turns).toEqual([
      { role: 'user', text: '问题' },
      { role: 'assistant', text: '回答' },
    ]);
  });

  // 界面上那一句（displayContent）比发给模型的投影更接近用户看到的东西
  it('prefers displayContent when the UI has one', () => {
    const turns = conversationTurns([{ role: 'user', content: '发给模型的', displayContent: '用户看到的' }]);
    expect(turns[0].text).toBe('用户看到的');
  });

  it('skips empty messages instead of emitting blank sections', () => {
    expect(conversationTurns([{ role: 'assistant', content: '   ' }])).toEqual([]);
    expect(conversationTurns(undefined)).toEqual([]);
  });
});

describe('describeModel', () => {
  it('joins provider and model, and does not repeat a model prefix', () => {
    expect(describeModel({ provider: 'Moonshot', model: 'kimi-k3' })).toBe('Moonshot / kimi-k3');
    expect(describeModel({ provider: 'openrouter', model: 'moonshotai/kimi-k3' })).toBe(
      'openrouter / moonshotai/kimi-k3',
    );
    expect(describeModel({ model: 'gpt-5' })).toBe('gpt-5');
    expect(describeModel({})).toBe('');
  });
});

describe('sessionMarkdown', () => {
  const messages = [
    { role: 'user' as const, content: '第一条问题' },
    { role: 'assistant' as const, content: '第一条回答\n\n带一段代码：\n```\nls\n```' },
  ];

  it('writes the session facts and numbered turns', () => {
    const markdown = sessionMarkdown(
      {
        title: '排查 IM 权限',
        sessionId: 'abc123',
        cwd: '/Users/demo/project',
        role: '商诉排查',
        provider: 'Moonshot',
        model: 'kimi-k3',
      },
      messages,
    );
    expect(markdown.startsWith('# 排查 IM 权限\n')).toBe(true);
    expect(markdown).toContain('- 会话 ID：abc123');
    expect(markdown).toContain('- 路径：/Users/demo/project');
    expect(markdown).toContain('- 模型：Moonshot / kimi-k3');
    expect(markdown).toContain('- 角色：商诉排查');
    expect(markdown).toContain('- 对话条数：2');
    expect(markdown).toContain('## 对话');
    expect(markdown).toContain('### 1. 用户\n\n第一条问题');
    // 回答里的代码块与空行原样保留：复制出去要还是 markdown
    expect(markdown).toContain('### 2. 助手\n\n第一条回答\n\n带一段代码：');
    expect(markdown.endsWith('\n')).toBe(true);
  });

  it('leaves out facts it does not know instead of writing empty rows', () => {
    const markdown = sessionMarkdown({ sessionId: 'abc' }, []);
    expect(markdown).not.toContain('- 路径：');
    expect(markdown).not.toContain('- 模型：');
    // `default` 是「没选角色」，不是用户选的分类：写出来只是噪音。
    expect(markdown).not.toContain('- 角色：');
    expect(sessionMarkdown({ sessionId: 'abc', role: 'default' }, [])).not.toContain('- 角色：');
    // 没有标题时用 id 当标题，读者才知道这是哪条会话
    expect(markdown.startsWith('# abc\n')).toBe(true);
    expect(markdown).toContain('（这条会话还没有对话内容）');
  });

  it('does not put tool calls or thinking into the copy', () => {
    // provider 侧的投影里只有 user / assistant 两种角色；这里用一条带 tool 角色的历史
    // 确认它会被称为「不是对话」而被丢掉，而不是被当成某一句正文。
    const turns = conversationTurns([
      { role: 'user' as const, content: '跑一下测试' },
      { role: 'tool' as unknown as 'user', content: 'test output 3000 lines' },
      { role: 'assistant' as const, content: '都过了' },
    ]);
    expect(turns.map((turn) => turn.text)).toEqual(['跑一下测试', '都过了']);
  });
});

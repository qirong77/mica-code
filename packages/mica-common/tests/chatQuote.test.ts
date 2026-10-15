import { describe, expect, it } from 'vitest';
import {
  findQuoteBlocks,
  formatQuoteBlock,
  hasQuoteBlock,
  insertQuoteBlock,
  quoteTitleText,
  removeQuoteBlock,
  splitQuoteSegments,
} from '../chatQuote.js';

const userBlock = (text: string) => formatQuoteBlock({ role: 'user', text });

describe('formatQuoteBlock', () => {
  it('wraps the quoted message behind a labelled fence', () => {
    expect(userBlock('你好')).toBe('引用对话（我）：\n```\n你好\n```');
    expect(formatQuoteBlock({ role: 'assistant', text: '在的' })).toBe(
      '引用对话（模型）：\n```\n在的\n```'
    );
  });

  it('lengthens the fence when the body already contains backticks', () => {
    const block = userBlock('看这段 ```js\nconst a = 1\n```');
    expect(block).toContain('````\n');
    expect(block.endsWith('\n````')).toBe(true);
    // 解析回来仍是同一个块：围栏长度必须自洽
    expect(findQuoteBlocks(block)).toHaveLength(1);
    expect(findQuoteBlocks(block)[0]?.text).toBe('看这段 ```js\nconst a = 1\n```');
  });

  it('downgrades image references so quoting does not re-upload the picture', () => {
    expect(userBlock('看这张 [Image](~/.mica/images/a.png)')).toContain('[图片]');
    expect(userBlock('![shot](/tmp/b.jpg)')).toContain('[图片]');
    // 普通链接不受影响
    expect(userBlock('见 [文档](https://example.com/x)')).toContain('[文档](https://example.com/x)');
  });

  it('trims surrounding blank lines from the quoted text', () => {
    expect(userBlock('\n\n  只有正文  \n\n')).toBe('引用对话（我）：\n```\n  只有正文\n```');
  });
});

describe('findQuoteBlocks', () => {
  it('returns every block with offsets that slice back to the same text', () => {
    const text = `引用对话（我）：\n\`\`\`\n第一段\n\`\`\`\n\n问题\n\n引用对话（模型）：\n\`\`\`\n第二段\n\`\`\``;
    const blocks = findQuoteBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((block) => [block.role, block.label, block.text])).toEqual([
      ['user', '我', '第一段'],
      ['assistant', '模型', '第二段'],
    ]);
    for (const block of blocks) expect(text.slice(block.start, block.end)).toContain('```');
    expect(text.slice(blocks[1]!.end)).toBe('');
  });

  it('keeps a custom signature and reports no role', () => {
    const [block] = findQuoteBlocks('引用对话（运维群）：\n```\n磁盘满了\n```');
    expect(block).toMatchObject({ label: '运维群', role: null, text: '磁盘满了' });
  });

  it('ignores label lines that are not followed by a fence', () => {
    expect(findQuoteBlocks('引用对话（我）：没有围栏')).toEqual([]);
    expect(findQuoteBlocks('引用对话（我）：\n```\n没有闭合')).toEqual([]);
    // 围栏短于开启围栏不算闭合
    expect(findQuoteBlocks('引用对话（我）：\n````\n正文\n```')).toEqual([]);
  });

  it('is cheap and safe for ordinary text', () => {
    expect(hasQuoteBlock('一段普通的话')).toBe(false);
    expect(findQuoteBlocks('')).toEqual([]);
  });
});

describe('insertQuoteBlock', () => {
  const block = userBlock('原文');

  it('starts an empty draft with the block and leaves the caret on the blank line', () => {
    const result = insertQuoteBlock('', 0, block);
    expect(result.text).toBe(`${block}\n\n`);
    expect(result.caret).toBe(result.text.length);
  });

  it('separates the block from text the caret sits inside', () => {
    const result = insertQuoteBlock('已有问题', 2, block);
    expect(result.text).toBe(`已有\n\n${block}\n\n问题`);
    // 光标落在块后的空行上，不落在「问题」里面
    expect(result.text.slice(result.caret)).toBe('问题');
  });

  it('does not stack blank lines when the caret already starts a line', () => {
    const result = insertQuoteBlock('第一行\n', 4, block);
    expect(result.text).toBe(`第一行\n${block}\n\n`);
    expect(result.caret).toBe(result.text.length);
  });

  it('reuses the existing blank line after the block', () => {
    const result = insertQuoteBlock(`${block}\n\n问题`, block.length, block);
    expect(result.text).toBe(`${block}\n\n${block}\n\n问题`);
    // 复用了 tail 自带的空行，光标同样跳过两个换行、正好停在已有文字之前
    expect(result.text.slice(result.caret)).toBe('问题');
  });
});

describe('removeQuoteBlock', () => {
  it('removes a leading block together with the blank line it left behind', () => {
    const text = `${userBlock('原文')}\n\n我的问题`;
    expect(removeQuoteBlock(text, findQuoteBlocks(text)[0]!)).toBe('我的问题');
  });

  it('keeps the blank line between the surrounding paragraphs', () => {
    const text = `上面\n\n${userBlock('原文')}\n\n下面`;
    expect(removeQuoteBlock(text, findQuoteBlocks(text)[0]!)).toBe('上面\n\n下面');
  });

  it('removes a trailing block and its separator', () => {
    const text = `我的问题\n\n${userBlock('原文')}`;
    expect(removeQuoteBlock(text, findQuoteBlocks(text)[0]!)).toBe('我的问题');
  });

  it('removes only the block that was clicked', () => {
    const first = userBlock('一');
    const second = userBlock('二');
    const text = `${first}\n\n${second}\n\n问题`;
    const blocks = findQuoteBlocks(text);
    expect(removeQuoteBlock(text, blocks[1]!)).toBe(`${first}\n\n问题`);
  });

  it('is a no-op when the block is gone', () => {
    const text = '已经没有引用了';
    expect(removeQuoteBlock(text, { start: 0, end: 10, label: '我', role: 'user', text: 'x' })).toBe(text);
  });
});

describe('splitQuoteSegments', () => {
  it('returns a single text segment when there is no quote', () => {
    expect(splitQuoteSegments('普通文本')).toEqual([{ type: 'text', text: '普通文本' }]);
  });

  it('splits the quoted block out of the surrounding text', () => {
    const text = `${userBlock('原文')}\n\n我的问题`;
    expect(splitQuoteSegments(text)).toEqual([
      { type: 'quote', role: 'user', label: '我', text: '原文' },
      { type: 'text', text: '\n\n我的问题' },
    ]);
  });
});

describe('quoteTitleText', () => {
  it('uses what the user actually wrote after the quote', () => {
    expect(quoteTitleText(`${userBlock('一大段日志')}\n\n帮我看看这个报错`)).toBe('帮我看看这个报错');
  });

  it('falls back to the quoted content when the message is only a quote', () => {
    expect(quoteTitleText(userBlock('只有引用'))).toBe('引用（我）：只有引用');
  });

  it('skips stacked quotes', () => {
    const text = `${userBlock('一')}\n\n${formatQuoteBlock({ role: 'assistant', text: '二' })}\n\n问题`;
    expect(quoteTitleText(text)).toBe('问题');
  });

  it('leaves ordinary text alone', () => {
    expect(quoteTitleText('  普通  问题 ')).toBe('普通 问题');
  });
});

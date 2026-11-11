import { describe, expect, it } from 'vitest';
import type { MicaUiContentBlockParam, MicaUiConversationMessage } from '@packages/mica-ui/index.js';
import { cleanSummary, digestInput, lastAssistantText, shouldDigest } from './digest.js';

const assistant = (content: string | MicaUiContentBlockParam[]): MicaUiConversationMessage => ({
  role: 'assistant',
  content,
});

describe('reply digest helpers', () => {
  it('takes only the last assistant message and supports text blocks', () => {
    const messages: MicaUiConversationMessage[] = [
      { role: 'assistant', content: '旧回复' },
      { role: 'notice', content: '插件提示' },
      assistant('第一段'),
      assistant([
        { type: 'text', text: '最后' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ignored' } },
        { type: 'text', text: '一条' },
      ]),
    ];

    expect(lastAssistantText(messages)).toBe('最后\n一条');
  });

  it('does not reuse a reply from before the latest user input', () => {
    expect(lastAssistantText([
      assistant('上一轮的长回复'),
      { role: 'user', content: '继续执行工具' },
      { role: 'notice', content: '工具已完成' },
    ])).toBe('');
    expect(lastAssistantText([
      assistant('上一轮的长回复'),
      { role: 'user', content: '新请求' },
      assistant('本轮回复'),
      { role: 'notice', content: '插件提示' },
    ])).toBe('本轮回复');
  });

  it('triggers on character count or many non-empty lines', () => {
    expect(shouldDigest('a'.repeat(1800), { charThreshold: 1800, lineThreshold: 36 })).toBe(true);
    expect(
      shouldDigest(
        Array.from({ length: 36 }, (_, index) => `第 ${index + 1} 行`).join('\n'),
        { charThreshold: 1800, lineThreshold: 36 },
      ),
    ).toBe(true);
    expect(shouldDigest('短回复', { charThreshold: 1800, lineThreshold: 36 })).toBe(false);
  });

  it('bounds model input and cleans the model label', () => {
    expect(digestInput('abcdef', 4)).toBe('abc…');
    expect(cleanSummary('摘要：\n- 已完成测试\n- 未发现问题', 600)).toBe('- 已完成测试\n- 未发现问题');
    expect(cleanSummary('x'.repeat(10), 5)).toBe('xxxx…');
  });
});

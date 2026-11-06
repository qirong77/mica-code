import { describe, expect, it } from 'vitest';
import { applyImageBudget, describeImageBudget, MAX_SINGLE_IMAGE_BYTES } from './imageBudget.js';

const MB = 1024 * 1024;

type ResponsesPart = { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail?: string };
type ResponsesMessage = { type: 'message'; role: string; content: ResponsesPart[] };
type ChatPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type ChatMessage = { role: string; content: ChatPart[] };

function dataUrl(bytes: number, seed = 'A'): string {
  return `data:image/png;base64,${seed.repeat(bytes)}`;
}

function responsesHistory(count: number, bytes: number): ResponsesMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    type: 'message' as const,
    role: 'user',
    content: [
      { type: 'input_text' as const, text: `第 ${index} 张` },
      { type: 'input_image' as const, image_url: dataUrl(bytes, String(index % 10)), detail: 'auto' },
    ],
  }));
}

function chatHistory(count: number, bytes: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: 'user',
    content: [
      { type: 'text' as const, text: `第 ${index} 张` },
      { type: 'image_url' as const, image_url: { url: dataUrl(bytes, String(index % 10)) } },
    ],
  }));
}

function isOmitted(part: ResponsesPart | ChatPart): boolean {
  return part.type === ('input_text' as string) && (part as { text: string }).text.startsWith('[图片已省略]');
}

describe('applyImageBudget', () => {
  it('没超预算时原样返回同一个对象，不做无谓复制', () => {
    const messages = responsesHistory(2, 1000);
    const { value, report } = applyImageBudget(messages, { maxBodyBytes: 1 * MB });
    expect(value).toBe(messages);
    expect(report.droppedImages).toBe(0);
    expect(report.keptImages).toBe(2);
  });

  it('超预算时把最旧的换成占位文本，最新那张一定还在', () => {
    const messages = responsesHistory(6, 1 * MB);
    const { value, report } = applyImageBudget(messages, { maxBodyBytes: 3.5 * MB });

    expect(report.droppedImages).toBeGreaterThan(0);
    const parts = value.flatMap((message) => message.content);
    expect(parts.filter(isOmitted).length).toBe(report.droppedImages);
    expect(value.at(-1)!.content.some((part) => part.type === 'input_image')).toBe(true);
    expect(value[0]!.content.some(isOmitted)).toBe(true);
    expect(describeImageBudget(report)).toContain('移除');
    expect(report.resultBytes).toBeLessThan(report.bodyBytes);
  });

  it('保留的总是最新那几张：丢最旧的，不是随便丢', () => {
    const tagged: ResponsesMessage[] = Array.from({ length: 6 }, (_, index) => ({
      type: 'message' as const,
      role: 'user',
      content: [{ type: 'input_image' as const, image_url: `data:image/png;base64,${String(index).repeat(1 * MB)}` }],
    }));
    const { value } = applyImageBudget(tagged, { maxBodyBytes: 2.5 * MB });
    const kept = value
      .map((message, index) => ({ index, message }))
      .filter((entry) => entry.message.content.some((part) => part.type === 'input_image'))
      .map((entry) => entry.index);
    expect(kept).toEqual([4, 5]);
  });

  it('单张超过单张上限时，即使是最新的一张也换成占位文本', () => {
    const messages: ResponsesMessage[] = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: dataUrl(MAX_SINGLE_IMAGE_BYTES + 1) }],
      },
    ];
    const { value, report } = applyImageBudget(messages, { maxBodyBytes: 64 * MB });
    expect(report.droppedImages).toBe(1);
    const placeholder = value[1]!.content[0]!;
    expect(placeholder.type).toBe('input_text');
    expect(placeholder.type === 'input_text' ? placeholder.text : '').toContain('单张上限');
  });

  it('Chat Completions 形状用 text 占位，且不碰原来的对象', () => {
    const messages = chatHistory(4, 1 * MB);
    const { value, report } = applyImageBudget(messages, { maxBodyBytes: 2.5 * MB });
    expect(report.droppedImages).toBeGreaterThan(0);
    expect(value[0]!.content[1]).toEqual({ type: 'text', text: expect.stringContaining('[图片已省略]') });
    // 入参保持不变：发送副本与持久化历史是两份。
    expect(messages[0]!.content[1]).toMatchObject({ type: 'image_url' });
  });

  it('助手消息里的图片换成 output_text（Responses 只认这个类型）', () => {
    type AssistantPart = { type: string; image_url?: string; annotations?: unknown[] };
    const messages: { type: string; role: string; content: AssistantPart[] }[] = [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'input_image', image_url: dataUrl(MAX_SINGLE_IMAGE_BYTES + 1) }],
      },
    ];
    const { value } = applyImageBudget(messages, { maxBodyBytes: 64 * MB });
    const part = value[0]!.content[0]!;
    expect(part.type).toBe('output_text');
    expect(part.annotations).toEqual([]);
  });

  it('文本也计入预算：正文越大，留给图片的额度越小', () => {
    const messages = responsesHistory(3, 1 * MB);
    const { report } = applyImageBudget(messages, { maxBodyBytes: 2 * MB });
    expect(report.budgetBytes).toBeLessThan(2 * MB);
    expect(report.bodyBytes).toBeGreaterThan(report.imageBytes);
  });
});

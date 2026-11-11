import { describe, expect, it } from 'vitest';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { applyImageBudget, describeImageBudget, MAX_SINGLE_IMAGE_BYTES } from './imageBudget.js';

const MB = 1024 * 1024;

function history(count: number, bytes: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    role: 'user',
    timestamp: index,
    content: [
      { type: 'text', text: `第 ${index} 张` },
      { type: 'image', data: String(index % 10).repeat(bytes), mimeType: 'image/png' },
    ],
  }));
}

function parts(messages: Message[]) {
  return messages.flatMap<Exclude<Message['content'], string>[number]>(
    (message) => (typeof message.content === 'string' ? [] : message.content),
  );
}

describe('applyImageBudget', () => {
  it('returns the original history when every image fits', () => {
    const messages = history(2, 1000);
    const { value, report } = applyImageBudget(messages, { maxBodyBytes: MB });
    expect(value).toBe(messages);
    expect(report.droppedImages).toBe(0);
    expect(report.keptImages).toBe(2);
  });

  it('omits the oldest images while preserving the newest and the persisted history', () => {
    const messages = history(6, MB);
    const { value, report } = applyImageBudget(messages, { maxBodyBytes: 2.5 * MB });
    const kept = value
      .map((message, index) => ({ index, message }))
      .filter(
        ({ message }) => typeof message.content !== 'string' && message.content.some((part) => part.type === 'image'),
      )
      .map(({ index }) => index);
    expect(kept).toEqual([4, 5]);
    expect(report.droppedImages).toBe(4);
    expect(report.resultBytes).toBeLessThan(report.bodyBytes);
    expect(describeImageBudget(report)).toContain('移除');
    expect(value[0]!.content).toContainEqual({ type: 'text', text: expect.stringContaining('[图片已省略]') });
    expect(messages[0]!.content).toContainEqual(expect.objectContaining({ type: 'image' }));
    expect(value.at(-1)).toBe(messages.at(-1));
  });

  it('omits a single oversized image even when it is the newest', () => {
    const messages = history(1, MAX_SINGLE_IMAGE_BYTES + 1);
    const { value, report } = applyImageBudget(messages, { maxBodyBytes: 64 * MB });
    expect(report.droppedImages).toBe(1);
    expect(value[0]!.content).toContainEqual({ type: 'text', text: expect.stringContaining('单张上限') });
    expect(parts(value).some((part) => part.type === 'image')).toBe(false);
  });

  it('budgets tool-result images with user images and leaves their metadata intact', () => {
    const messages = history(1, MB);
    messages.push({
      role: 'toolResult',
      toolCallId: 'image-call',
      toolName: 'read_image',
      content: [{ type: 'image', data: 'X'.repeat(MB), mimeType: 'image/png' }],
      isError: false,
      timestamp: 2,
    });
    const { value, report } = applyImageBudget(messages, { maxBodyBytes: 1.5 * MB });
    expect(report.keptImages).toBe(1);
    expect(value[1]).toBe(messages[1]);
    expect(parts(value.slice(0, 1)).some((part) => part.type === 'image')).toBe(false);
  });

  it('counts text toward the body budget', () => {
    const messages = history(3, MB);
    const { report } = applyImageBudget(messages, { maxBodyBytes: 2 * MB });
    expect(report.budgetBytes).toBeLessThan(2 * MB);
    expect(report.bodyBytes).toBeGreaterThan(report.imageBytes);
  });

  it('keeps image-shaped tool arguments intact and counts them as request text', () => {
    const response: AssistantMessage = {
      role: 'assistant',
      api: 'openai-responses',
      provider: 'test',
      model: 'test',
      timestamp: 1,
      stopReason: 'toolUse',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      content: [
        {
          type: 'toolCall',
          id: 'write-config',
          name: 'write_config',
          arguments: { asset: { type: 'image', data: 'A'.repeat(MB), mimeType: 'image/png' } },
        },
      ],
    };
    const messages: Message[] = [response, ...history(1, MB)];
    const { value, report } = applyImageBudget(messages, { maxBodyBytes: 1.5 * MB });
    expect(report.imageBytes).toBe(MB);
    expect(report.droppedImages).toBe(1);
    expect(report.budgetBytes).toBeLessThan(0.5 * MB);
    expect(value[0]).toBe(response);
    expect(parts(value.slice(1)).some((part) => part.type === 'image')).toBe(false);
  });
});

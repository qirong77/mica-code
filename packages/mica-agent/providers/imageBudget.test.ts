import { describe, expect, it } from 'vitest';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import {
  applyImageBudget,
  createRequestImagePreparer,
  describeImageBudget,
  MAX_SINGLE_IMAGE_BYTES,
} from './imageBudget.js';
import { encodePng, decodePng } from '@packages/mica-common/imagePng.js';

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
  return messages.flatMap<Exclude<Message['content'], string>[number]>((message) =>
    typeof message.content === 'string' ? [] : message.content,
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

describe('request image preparation', () => {
  function png(width: number, height: number): string {
    return encodePng({ width, height, channels: 3, data: new Uint8Array(width * height * 3) }).toString('base64');
  }

  it('normalizes restored user and tool images without mutating persisted history, then reuses the result', async () => {
    const data = png(10, 9000);
    const messages: Message[] = [
      { role: 'user', timestamp: 1, content: [{ type: 'image', data, mimeType: 'image/png' }] },
      {
        role: 'toolResult',
        toolName: 'screenshot',
        toolCallId: 'shot',
        timestamp: 2,
        isError: false,
        content: [
          { type: 'text', text: 'screenshot' },
          { type: 'image', data, mimeType: 'image/jpeg' },
        ],
      },
    ];
    const prepare = createRequestImagePreparer();
    const first = await prepare(messages);
    const second = await prepare(messages);
    const images = parts(first).filter((part) => part.type === 'image');
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image.mimeType).toBe('image/png');
      expect(decodePng(Buffer.from(image.data, 'base64')).height).toBe(1568);
    }
    expect(parts(first)).toContainEqual({ type: 'text', text: expect.stringContaining('10x9000 → 2x1568') });
    expect(parts(second).filter((part) => part.type === 'image')[0]).toBe(images[0]);
    expect(parts(messages).filter((part) => part.type === 'image')[0]!.data).toBe(data);
    expect(first[1]).toMatchObject({ toolCallId: 'shot', toolName: 'screenshot', isError: false });
  });

  it('replaces unusable images with actionable text and preserves usable images and message order', async () => {
    const extreme = Buffer.from(png(1, 1), 'base64');
    extreme.writeUInt32BE(2360, 16);
    extreme.writeUInt32BE(32000, 20);
    const messages: Message[] = [
      {
        role: 'user',
        timestamp: 1,
        content: [
          { type: 'text', text: 'before' },
          { type: 'image', data: extreme.toString('base64'), mimeType: 'image/png' },
          { type: 'image', data: 'private invalid payload', mimeType: 'image/png' },
          { type: 'image', data: png(20, 10), mimeType: 'image/png' },
        ],
      },
    ];
    const result = await createRequestImagePreparer()(messages);
    expect(parts(result)[0]).toEqual({ type: 'text', text: 'before' });
    expect(parts(result)[1]).toMatchObject({ text: expect.stringContaining('分段截图') });
    expect(parts(result)[2]).toMatchObject({ text: expect.stringContaining('[图片已省略]') });
    expect(parts(result).filter((part) => part.type === 'image')).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('private invalid payload');
    expect(parts(messages).filter((part) => part.type === 'image')).toHaveLength(3);
  });

  it('keeps the original array when valid images need no processing', async () => {
    const messages: Message[] = [
      { role: 'user', timestamp: 1, content: [{ type: 'image', data: png(10, 10), mimeType: 'image/png' }] },
    ];
    expect(await createRequestImagePreparer()(messages)).toBe(messages);
  });
});

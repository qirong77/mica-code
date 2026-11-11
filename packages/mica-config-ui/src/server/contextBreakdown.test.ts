import { describe, expect, it } from 'vitest';
import { estimateContextTokens, summarizeContextItems } from './contextBreakdown.js';

describe('summarizeContextItems', () => {
  it('splits an assistant message into text, tool-call arguments and envelope', () => {
    const { items, categories } = summarizeContextItems([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reading the file' },
          { id: 'call-1', type: 'toolCall', name: 'read_file', arguments: { file_path: 'a.ts' } },
        ],
      },
    ]);

    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.sequence).toBe(1);
    expect(item.kind).toBe('assistant');
    expect(item.toolCalls?.[0]).toMatchObject({ id: 'call-1', name: 'read_file' });
    expect(item.parts.assistant).toBe('reading the file'.length);
    expect(item.parts.tool_call).toBe('{"file_path":"a.ts"}'.length);
    // 结构字段（role / toolCall 的 id、type）单列一类，不与正文混在一起。
    expect(item.parts.envelope).toBeGreaterThan(0);
    expect(item.chars).toBe((item.parts.assistant ?? 0) + (item.parts.tool_call ?? 0) + (item.parts.envelope ?? 0));

    const byKind = new Map(categories.map((row) => [row.kind, row]));
    expect(byKind.get('assistant')?.count).toBe(1);
    expect(byKind.get('tool_call')?.tokens).toBe(estimateContextTokens(item.parts.tool_call ?? 0));
  });

  it('never counts media payload but keeps the image count', () => {
    const { items, imageCount, messageTokens } = summarizeContextItems([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', data: 'A'.repeat(50_000), mimeType: 'image/png' },
        ],
      },
    ]);

    expect(items[0].imageCount).toBe(1);
    expect(imageCount).toBe(1);
    // 内联 base64 不该进估算：整条消息只剩「look」+ 结构字段。
    expect(messageTokens).toBeLessThan(100);
    expect(items[0].content).toBe('look\n[image]');
  });

  it('counts encrypted reasoning payloads as size, not as readable content', () => {
    const { items, categories } = summarizeContextItems([
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'thought', thinkingSignature: 'x'.repeat(400) }],
      },
    ]);

    const [item] = items;
    expect(item.kind).toBe('reasoning');
    expect(item.encryptedChars).toBe(400);
    expect(item.parts.reasoning).toBeGreaterThanOrEqual(400);
    expect(item.content).toBe('thought');
    expect(categories.find((row) => row.kind === 'reasoning')?.count).toBe(1);
  });

  it('marks tool results cleared by compact', () => {
    const { items, clearedResults } = summarizeContextItems([
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: '[Old tool result content cleared during compact]' }],
      },
    ]);

    expect(items[0].cleared).toBe(true);
    expect(clearedResults).toBe(1);
  });

  it('sorts categories by volume and keeps tiny categories', () => {
    const { categories } = summarizeContextItems([
      { role: 'user', content: 'small' },
      { role: 'toolResult', toolCallId: 'c', content: [{ type: 'text', text: 'x'.repeat(4_000) }] },
    ]);

    expect(categories[0].kind).toBe('tool_result');
    expect(categories.map((row) => row.kind)).toContain('user');
    expect(categories.map((row) => row.kind)).toContain('envelope');
  });

  it('keeps Pi accounting metadata out of input estimates and hides thinking signatures', () => {
    const content = [
      { type: 'thinking', thinking: 'checking', thinkingSignature: 'private-signature' },
      { type: 'toolCall', id: 'call', name: 'read_file', arguments: { file_path: 'a.ts' } },
    ];
    const plain = summarizeContextItems([{ role: 'assistant', content }]);
    const metadata = summarizeContextItems([
      {
        role: 'assistant',
        content,
        timestamp: 1234,
        api: 'anthropic-messages',
        provider: 'anthropic',
        usage: { input: 100000, output: 1000, cost: { total: 300 } },
        stopReason: 'toolUse',
      },
    ]);
    expect(metadata.messageChars).toBe(plain.messageChars);
    expect(metadata.items[0].parts.reasoning).toBe('checking'.length + 'private-signature'.length);
    expect(metadata.items[0].parts.tool_call).toBe(JSON.stringify({ file_path: 'a.ts' }).length);
    expect(JSON.stringify(metadata)).not.toContain('private-signature');
  });
});

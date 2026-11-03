import { describe, expect, it } from 'vitest';
import {
  buildTurnBlocks,
  conversationFilterOf,
  conversationPreview,
  describeConversationRun,
  formatTurnStats,
  splitConversationRuns,
} from './conversationView.js';
import type { ConfigWebConversationItem, ConfigWebConversationItemType } from '../src/shared/types.js';

function item(
  sequence: number,
  type: ConfigWebConversationItemType,
  content = `content ${sequence}`,
  extra: Partial<ConfigWebConversationItem> = {},
): ConfigWebConversationItem {
  return { sequence, type, content, ...extra };
}

describe('conversationPreview', () => {
  it('把图片引用收成一枚占位', () => {
    // 一条多模态消息抽出来是「[Image](路径) + 一个裸 [Image]」，两种形态都要收掉。
    const content = '[Image](~/.mica/images/a.png) [Image] 这个背景不要毛玻璃';
    expect(conversationPreview(content, 600)).toBe('[图片] 这个背景不要毛玻璃');
  });

  it('认得出没有扩展名的图片路径', () => {
    const content = '![x](~/.mica/images/image-43cfd58f-b9e5) 看这里';
    expect(conversationPreview(content, 600)).toBe('[图片] 看这里');
  });

  it('不动 skill / MCP 这类能力引用', () => {
    const content = '[skill:commit](/root/skills/commit/SKILL.md) 提交';
    expect(conversationPreview(content, 600)).toBe(content);
  });

  it('超长内容按上限截断并标出省略号', () => {
    const preview = conversationPreview('x'.repeat(3_000), 20);
    expect(preview).toBe(`${'x'.repeat(20)}…`);
  });

  it('没丢内容时不加省略号', () => {
    expect(conversationPreview('短', 20)).toBe('短');
  });
});

describe('buildTurnBlocks', () => {
  it('每条用户消息开一段', () => {
    const blocks = buildTurnBlocks([item(1, 'system'), item(2, 'user', '问一句'), item(3, 'assistant'), item(4, 'user', '再问')]);
    expect(blocks.map((block) => block.turn?.sequence ?? null)).toEqual([null, 2, 4]);
    expect(blocks[1]?.records.map((record) => record.sequence)).toEqual([3]);
  });

  it('汇总一轮的工具、思考与体积', () => {
    const blocks = buildTurnBlocks([
      item(1, 'user', 'a'),
      item(2, 'reasoning', 'r', { sizeHint: 10 }),
      item(3, 'tool_call', '{}', { toolName: 'run_shell', sizeHint: 20 }),
      item(4, 'tool_result', 'ok', { sizeHint: 30 }),
    ]);
    expect(blocks[0]?.stats).toEqual({ records: 3, tools: 2, thinking: 1, chars: 60 });
    expect(formatTurnStats(blocks[0]!.stats)).toBe('3 条记录 · 工具 2 · 思考 1 · 60 字符');
  });

  it('用户消息后面没有记录时如实说明', () => {
    const blocks = buildTurnBlocks([item(1, 'user', 'a')]);
    expect(formatTurnStats(blocks[0]!.stats)).toBe('没有后续记录');
  });
});

describe('splitConversationRuns', () => {
  it('长动作段折叠、短段留在原地', () => {
    const records = [
      item(1, 'tool_call', '{}', { toolName: 'a' }),
      item(2, 'tool_result', 'ok'),
      item(3, 'tool_call', '{}', { toolName: 'b' }),
      item(4, 'tool_result', 'ok'),
      item(5, 'assistant'),
      item(6, 'tool_call', '{}', { toolName: 'c' }),
      item(7, 'tool_result', 'ok'),
    ];
    const runs = splitConversationRuns(records);
    expect(runs.map((run) => run.kind)).toEqual(['group', 'single', 'single', 'single']);
    expect(runs[0]!.kind === 'group' && runs[0]!.records.length).toBe(4);
  });

  it('切块后的尾巴仍然折着', () => {
    // 15 条 = 12 + 3：尾巴折着，不然同一批工具一半折着、一半摊着。
    const records = Array.from({ length: 15 }, (_, index) => item(index + 1, 'tool_result', 'ok'));
    const runs = splitConversationRuns(records);
    expect(runs.map((run) => run.kind)).toEqual(['group', 'group']);
    expect(runs.map((run) => run.kind === 'group' && run.records.length)).toEqual([12, 3]);
  });

  it('回答不并进动作段', () => {
    const runs = splitConversationRuns([item(1, 'tool_result'), item(2, 'assistant')]);
    expect(runs.map((run) => run.kind)).toEqual(['single', 'single']);
  });
});

describe('describeConversationRun', () => {
  it('把调用次数最多的工具排在前面', () => {
    const records = [
      item(1, 'tool_call', '{}', { toolName: 'run_shell' }),
      item(2, 'tool_result'),
      item(3, 'tool_call', '{}', { toolName: 'run_shell' }),
      item(4, 'tool_result'),
      item(5, 'tool_call', '{}', { toolName: 'read_file' }),
      item(6, 'tool_result'),
      item(7, 'reasoning'),
    ];
    expect(describeConversationRun(records)).toBe('7 条 · run_shell ×2、read_file ×1 · 思考 1');
  });

  it('纯思考的段不重复说一遍次数', () => {
    const records = [item(1, 'reasoning'), item(2, 'reasoning')];
    expect(describeConversationRun(records)).toBe('2 条');
  });
});

describe('conversationFilterOf', () => {
  it('按类型归到筛选页签', () => {
    expect(conversationFilterOf(item(1, 'user'))).toBe('talk');
    expect(conversationFilterOf(item(1, 'assistant'))).toBe('talk');
    expect(conversationFilterOf(item(1, 'tool_call'))).toBe('tools');
    expect(conversationFilterOf(item(1, 'tool_result'))).toBe('tools');
    expect(conversationFilterOf(item(1, 'reasoning'))).toBe('thinking');
  });
});

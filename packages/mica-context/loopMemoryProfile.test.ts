import { describe, it, expect } from 'vitest';
import { micaContext, isCompactionNotNeededError } from './index.js';

const LOOP_OPTIONS = {
  aggressive: true,
  force: true,
  lightweightPrune: true,
  pruneOnly: true,
  pruneOnlyThresholdRatio: 0.3,
  targetContextRatio: 0.35,
  minRecentRounds: 1,
  maxRecentRounds: 3,
  contextWindowSize: 200_000,
};

/** chat_messages 格式：user/assistant 交替，assistant 带 file 引用放大体积。 */
function round(turn: number): unknown[] {
  return [
    { role: 'user', content: `loop 任务轮次 ${turn}：请阅读并汇报 packages/example${turn}.ts 的导出。` },
    {
      role: 'assistant',
      content:
        `第 ${turn} 轮结果：packages/example${turn}.ts 导出了 helper。` +
        `\n\`\`\`\n${'export function helper() { return ' + turn + '; }\n'.repeat(40)}${turn}\`\`\``,
    },
  ];
}

function usage(turn: number): { provider: string; turnId: number; inputTokens: number; outputTokens: number } {
  return { provider: 'openai_chat_completions', turnId: turn, inputTokens: 100 + turn, outputTokens: 40 };
}

describe('loop memory profile (unit, real CompactionService)', () => {
  it('grows usageHistory unbounded while messages are kept bounded by prune-only compact', async () => {
    const service = new micaContext.CompactionService();
    let messages: unknown[] = [];
    const usageHistory: unknown[] = [];
    let skipped = 0;
    let applied = 0;

    for (let turn = 1; turn <= 40; turn++) {
      // Append this loop round's fresh messages + push a usage record.
      messages.push(...round(turn));
      usageHistory.push(usage(turn));

      // Same call path as compactBeforeLoopRun (loop.ts).
      try {
        const result = await service.compact({
          messages,
          options: LOOP_OPTIONS,
          summarize: async () => {
            throw new Error('prune-only must never summarize');
          },
        });
        if (result.messages.length > 0) {
          messages = result.messages;
          applied += 1;
        }
      } catch (error) {
        if (isCompactionNotNeededError(error)) {
          skipped += 1;
          continue;
        }
        throw error;
      }

      if (turn === 4 || turn === 10 || turn === 20 || turn === 40) {
        // eslint-disable-next-line no-console
        console.log(
          `round=${turn} messages=${messages.length} usageHistory=${usageHistory.length} ` +
            `rssMB=${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} skipped=${skipped} applied=${applied}`,
        );
      }
    }

    // messages must be bounded (prune-only drops older rounds); usageHistory must NOT.
    expect(messages.length).toBeLessThanOrEqual(40);
    expect(usageHistory.length).toBe(40);
    expect(applied).toBeGreaterThan(0);
  }, 30_000);
});

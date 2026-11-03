import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@packages/mica-ui/index.js', () => ({
  micaUi: {
    createThinkingLogItem: (id: string, text: string) => ({ id, text }),
  },
}));
vi.mock('@packages/mica-tools/index.js', () => ({ micaTools: {} }));
vi.mock('@packages/mica-config/runtimeEnv.js', () => ({
  runtimeEnv: { ui: { thinkingTextMaxChars: 1000, thinkingUpdateIntervalMs: 100 } },
}));

import { ToolLogController } from './ToolLogController.js';

describe('ToolLogController thinking segments', () => {
  afterEach(() => vi.useRealTimers());

  it('flushes throttled thinking before clearing the segment', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const sink = {
      setThinkingText: vi.fn(),
      appendAgentTurnLogItem: vi.fn(),
      replaceAgentTurnLogItem: vi.fn(),
    };
    const controller = new ToolLogController(sink);

    controller.appendThinking('first');
    controller.appendThinking(' tail');
    expect(sink.replaceAgentTurnLogItem).toHaveBeenCalledTimes(1);

    controller.endThinkingSegment();
    expect(sink.replaceAgentTurnLogItem).toHaveBeenLastCalledWith({ id: 'thinking-1', text: 'first tail' });
    expect(sink.setThinkingText).toHaveBeenLastCalledWith('');
    controller.endThinkingSegment();
    expect(sink.replaceAgentTurnLogItem).toHaveBeenCalledTimes(2);
  });

  it('restores a checkpoint in the log before the segment is flushed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const sink = {
      setThinkingText: vi.fn(),
      appendAgentTurnLogItem: vi.fn(),
      replaceAgentTurnLogItem: vi.fn(),
    };
    const controller = new ToolLogController(sink);

    controller.appendThinking('kept');
    const checkpoint = controller.checkpointThinking();
    vi.advanceTimersByTime(100);
    controller.appendThinking(' discarded');
    controller.restoreThinking(checkpoint);
    expect(sink.replaceAgentTurnLogItem).toHaveBeenLastCalledWith({ id: 'thinking-1', text: 'kept' });
    controller.endThinkingSegment();
    expect(sink.replaceAgentTurnLogItem).toHaveBeenLastCalledWith({ id: 'thinking-1', text: 'kept' });
  });

  it('flushes a throttled checkpoint and tracks changes across ended segments', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const sink = {
      setThinkingText: vi.fn(),
      appendAgentTurnLogItem: vi.fn(),
      replaceAgentTurnLogItem: vi.fn(),
    };
    const controller = new ToolLogController(sink);

    controller.appendThinking('first');
    controller.appendThinking(' completed');
    expect(sink.replaceAgentTurnLogItem).toHaveBeenCalledTimes(1);
    controller.markThinkingCheckpoint();
    expect(sink.replaceAgentTurnLogItem).toHaveBeenLastCalledWith({ id: 'thinking-1', text: 'first completed' });
    controller.appendThinking(' discarded');
    controller.endThinkingSegment();
    controller.appendThinking('another discarded segment');
    controller.endThinkingSegment();

    expect(controller.rollbackUncheckpointedThinking()).toEqual([
      { id: 'thinking-1', text: 'first completed' },
      { id: 'thinking-2', text: null },
    ]);
    expect(controller.rollbackUncheckpointedThinking()).toEqual([]);
    expect(sink.setThinkingText).toHaveBeenLastCalledWith('');
  });

  it('restores the checkpointed text when an active buffer has been truncated', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const sink = {
      setThinkingText: vi.fn(),
      appendAgentTurnLogItem: vi.fn(),
      replaceAgentTurnLogItem: vi.fn(),
    };
    const controller = new ToolLogController(sink);
    const completed = 'a'.repeat(950);
    controller.appendThinking(completed);
    controller.markThinkingCheckpoint();
    controller.appendThinking('b'.repeat(100));

    expect(controller.rollbackUncheckpointedThinking()).toEqual([{ id: 'thinking-1', text: completed }]);
    expect(sink.setThinkingText).toHaveBeenLastCalledWith(completed);
    controller.endThinkingSegment();
    expect(sink.replaceAgentTurnLogItem).toHaveBeenLastCalledWith({ id: 'thinking-1', text: completed });
  });

  it('restores pending checkpoint tracking along with a retry snapshot', () => {
    const sink = {
      setThinkingText: vi.fn(),
      appendAgentTurnLogItem: vi.fn(),
      replaceAgentTurnLogItem: vi.fn(),
    };
    const controller = new ToolLogController(sink);
    controller.appendThinking('before retry');
    const attempt = controller.checkpointThinking();
    controller.appendThinking(' failed');
    controller.markThinkingCheckpoint();
    controller.restoreThinking(attempt);

    expect(controller.rollbackUncheckpointedThinking()).toEqual([{ id: 'thinking-1', text: null }]);
    expect(sink.setThinkingText).toHaveBeenLastCalledWith('');
  });
});

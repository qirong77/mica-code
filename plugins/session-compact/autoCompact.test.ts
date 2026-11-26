import { describe, expect, it } from 'vitest';
import {
  HANDOFF_MARKER,
  MAX_FAILURES,
  RESUME_MARKER,
  buildHandoffPrompt,
  buildResumePrompt,
  compactThreshold,
  findHandoffReply,
  handoffDisplayText,
  isAutoInput,
  isHandoffInput,
  isResumeInput,
  normalizeAutoCompactState,
  readAutoCompactSettings,
  shouldTrigger,
  type AutoCompactSettings,
  type AutoCompactState,
} from './autoCompact.js';

const settings = (patch: Partial<AutoCompactSettings> = {}): AutoCompactSettings => ({
  ...readAutoCompactSettings({
    autoCompact: 'true',
    thresholdTokens: '400000',
    modelCompactThreshold: '100000',
    minIntervalMinutes: '10',
    autoResume: 'true',
    saveHandover: 'true',
  }),
  ...patch,
});

const idle = (patch: Partial<AutoCompactState> = {}): AutoCompactState => ({ phase: 'idle', ...patch });

const decide = (input: {
  usageTokens?: number;
  state?: AutoCompactState;
  queued?: number;
  contextWindowSize?: number;
  patch?: Partial<AutoCompactSettings>;
  now?: number;
}) =>
  shouldTrigger({
    settings: settings(input.patch),
    state: input.state ?? idle(),
    usage: input.usageTokens === undefined ? { inputTokens: 420_000 } : { inputTokens: input.usageTokens },
    ...(input.contextWindowSize !== undefined ? { contextWindowSize: input.contextWindowSize } : {}),
    queued: input.queued ?? 0,
    now: input.now ?? 1_000_000,
  });

describe('自动压缩触发条件', () => {
  it('读设置时缺项与非法值都落回默认', () => {
    const values = readAutoCompactSettings({});
    expect(values).toMatchObject({
      enabled: true,
      thresholdTokens: 400_000,
      modelCompactThreshold: 100_000,
      minIntervalMs: 600_000,
      autoResume: true,
      saveHandover: true,
    });
    expect(readAutoCompactSettings({ thresholdTokens: 'abc', minIntervalMinutes: '0' })).toMatchObject({
      thresholdTokens: 400_000,
      minIntervalMs: 0,
    });
    expect(readAutoCompactSettings({ autoCompact: 'false', autoResume: 'false' })).toMatchObject({
      enabled: false,
      autoResume: false,
    });
  });

  it('模型窗口比阈值小时提前到窗口的 90%', () => {
    expect(compactThreshold(settings(), undefined)).toBe(400_000);
    expect(compactThreshold(settings(), 1_000_000)).toBe(400_000);
    expect(compactThreshold(settings(), 200_000)).toBe(180_000);
    // 窗口很小的时候仍取更小的那个，不能反过来把阈值抬高。
    expect(compactThreshold(settings({ thresholdTokens: 50_000 }), 200_000)).toBe(50_000);
  });

  it('到阈值才触发，且把实际生效的阈值带回去', () => {
    expect(decide({ usageTokens: 399_999 })).toEqual({ trigger: false, reason: 'below-threshold' });
    expect(decide({ usageTokens: 400_000 })).toEqual({
      trigger: true,
      threshold: 400_000,
      usageTokens: 400_000,
    });
    expect(decide({ usageTokens: 190_000, contextWindowSize: 200_000 })).toMatchObject({
      trigger: true,
      threshold: 180_000,
    });
  });

  it('一次流程没走完、排队槽被占、还在冷却都不再插话', () => {
    expect(decide({ state: idle({ phase: 'compact' }) })).toEqual({ trigger: false, reason: 'not-idle' });
    expect(decide({ queued: 1 })).toEqual({ trigger: false, reason: 'queued' });
    expect(decide({ state: idle({ triggeredAt: 999_000 }) })).toEqual({ trigger: false, reason: 'cooldown' });
    expect(decide({ state: idle({ triggeredAt: 100_000 }), now: 1_000_000 })).toMatchObject({ trigger: true });
    expect(decide({ patch: { minIntervalMs: 0 }, state: idle({ triggeredAt: 999_999 }) })).toMatchObject({
      trigger: true,
    });
  });

  it('压缩后 lastUsage 不会变小：同一个数再来一次不算新用量', () => {
    expect(decide({ usageTokens: 420_000, state: idle({ staleUsageTokens: 420_000 }) })).toEqual({
      trigger: false,
      reason: 'stale-usage',
    });
    expect(decide({ usageTokens: 430_000, state: idle({ staleUsageTokens: 420_000 }) })).toMatchObject({
      trigger: true,
    });
  });

  it('压不动连续失败后停下来，等用户手动处理', () => {
    expect(decide({ state: idle({ failures: MAX_FAILURES }) })).toEqual({
      trigger: false,
      reason: 'too-many-failures',
    });
  });

  it('关闭自动压缩、没有用量都不触发', () => {
    expect(decide({ patch: { enabled: false } })).toEqual({ trigger: false, reason: 'disabled' });
    expect(
      shouldTrigger({
        settings: settings(),
        state: idle(),
        usage: null,
        queued: 0,
        now: 0,
      }),
    ).toEqual({ trigger: false, reason: 'no-usage' });
  });
});

describe('自动压缩的文本', () => {
  it('交接请求写明暂停、结构、具体性与结束条件', () => {
    const text = buildHandoffPrompt({ usageTokens: 412_300, thresholdTokens: 400_000, contextWindowSize: 1_000_000 });
    expect(text.startsWith(HANDOFF_MARKER)).toBe(true);
    expect(text).toContain('412.3K');
    expect(text).toContain('400.0K');
    expect(text).toContain('41%');
    for (const section of ['任务目标', '已完成', '进行中', '待办', '关键约束与坑', '下一步']) {
      expect(text).toContain(section);
    }
    expect(text).toContain('不要调用任何工具');
    expect(text).toContain('写完就停下等压缩完成');
    // 没声明窗口时不该编一个百分比出来。
    expect(buildHandoffPrompt({ usageTokens: 420_000, thresholdTokens: 400_000 })).not.toContain('模型窗口');
  });

  it('继续指令带压缩前后的数字，并给出「没有待办就停」的出口', () => {
    const text = buildResumePrompt({ beforeTokens: 412_300, afterTokens: 28_400 });
    expect(text.startsWith(RESUME_MARKER)).toBe(true);
    expect(text).toContain('412.3K');
    expect(text).toContain('28.4K');
    expect(text).toContain('没有待办，已收尾');
    expect(text).toContain('不要开始新的工作');
  });

  it('只认插件发出的带标记消息', () => {
    expect(isAutoInput({ text: `${HANDOFF_MARKER}…`, source: 'plugin' })).toBe(true);
    expect(isAutoInput({ text: `${HANDOFF_MARKER}…`, source: 'ui' })).toBe(false);
    expect(isAutoInput({ text: '随便说说', source: 'plugin' })).toBe(false);
    expect(isHandoffInput({ text: `${HANDOFF_MARKER}…`, source: 'plugin' })).toBe(true);
    expect(isResumeInput({ text: `${RESUME_MARKER}…`, source: 'plugin' })).toBe(true);
    expect(isHandoffInput({ text: `${RESUME_MARKER}…`, source: 'plugin' })).toBe(false);
  });
});

describe('交接文档取回', () => {
  const request = buildHandoffPrompt({ usageTokens: 420_000, thresholdTokens: 400_000 });

  it('取我们那条请求之后的第一条助手消息', () => {
    const messages = [
      { role: 'user', content: '帮我重构模块' },
      { role: 'assistant', content: '好的，先看代码' },
      { role: 'user', content: request },
      { role: 'assistant', content: '## 任务目标\n重构' },
      { role: 'assistant', content: '后面补充的一句' },
    ];
    expect(findHandoffReply(messages, request)).toBe('## 任务目标\n重构');
  });

  it('消息正文是内容块时只拼文本块', () => {
    const messages = [
      { role: 'user', content: request },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '## 待办' },
          { type: 'tool_use', id: 'x' },
          { type: 'text', text: '- 继续修' },
        ],
      },
    ];
    expect(findHandoffReply(messages, request)).toBe('## 待办\n- 继续修');
  });

  it('会话里存的是展示文本（短句）时也能按标记找回最近那份', () => {
    const messages = [
      { role: 'user', content: request },
      { role: 'assistant', content: '旧文档' },
      { role: 'user', content: handoffDisplayText(420_000, 400_000) },
      { role: 'assistant', content: '新文档' },
    ];
    expect(findHandoffReply(messages, request)).toBe('新文档');
  });

  it('找不到请求或回复就返回空串，不拿别的助手消息凑数', () => {
    expect(findHandoffReply([{ role: 'assistant', content: '旧回答' }], request)).toBe('');
    expect(findHandoffReply([{ role: 'user', content: request }], request)).toBe('');
  });
});

describe('状态归一化', () => {
  it('只保留认识的阶段与有限数字，脏数据整项丢弃', () => {
    expect(normalizeAutoCompactState(undefined)).toEqual({ phase: 'idle' });
    expect(normalizeAutoCompactState('nope')).toEqual({ phase: 'idle' });
    expect(normalizeAutoCompactState({ phase: 'exploded' })).toEqual({ phase: 'idle' });
    expect(
      normalizeAutoCompactState({
        phase: 'compact',
        phaseAt: 1,
        compactedTokens: Number.NaN,
        failures: 2,
        runs: -1,
        userIntervened: 'yes',
        lastResult: '  ',
        extra: 'dropped',
      }),
    ).toEqual({ phase: 'compact', phaseAt: 1, failures: 2 });
  });
});

/**
 * 一轮的时间去哪了。
 *
 * 一轮按「在等什么」切成首尾相接的区间：请求发出到第一个 token 是「等待模型」，
 * 流式输出期间是「模型输出」，工具从发出到结果回来是「工具执行」。区间之间不留空隙，
 * 所以三类合计正好是整轮耗时。
 *
 * 这里是唯一实现：进程侧（`AgentRuntime` 每轮跑完把记录写进会话快照）与界面侧
 * （桌面端实时事件、会话详情页读盘）共用同一套区间切分与聚合，谁也不另算一遍——
 * 否则弹窗里的 63% 和会话详情里的 63% 会在某次改动之后悄悄对不上。
 *
 * 记录只保留最近 {@link MAX_TURN_TIMINGS} 轮：它服务的是「刚才那一轮慢在哪」，
 * 不是长期统计（那是 Stats 的用量账）。
 */

export type TurnTimingKind = 'wait' | 'generate' | 'tool';

export type TurnTimingOutcome = 'completed' | 'aborted' | 'error' | 'paused';

export type TurnTimingToolStatus = 'pending' | 'completed' | 'aborted' | 'error';

export type TurnTimingSegment = {
  kind: TurnTimingKind;
  /** 绝对毫秒时间戳（与本轮起点同一时钟）。 */
  start: number;
  end: number;
  /** 工具段的工具名（`run_shell`）；同一类工具被调多次时靠它聚合。 */
  tool?: string;
  callID?: string;
  displayText?: string;
  status?: TurnTimingToolStatus;
  /** 输出段收到的字符数（正文 + 思考）。 */
  chars?: number;
  /** 本轮结束前补的那条收尾等待。 */
  tail?: boolean;
  /** 运行中现场推出来的、仍在进行的等待段。 */
  live?: boolean;
};

export type TurnTimingState = {
  startedAt: number;
  endedAt: number;
  lastAt: number;
  segments: TurnTimingSegment[];
  /** 仍在进行的那一段在 `segments` 里的下标，-1 表示正等着下一次请求。 */
  openIndex: number;
  outcome: TurnTimingOutcome | null;
};

/**
 * 喂给状态机的最小事件。
 *
 * 只有这五种：谁在什么时候开始/结束一段。协议层的细节（Codex 的 item、provider 的
 * 回调）由各自的适配器翻译成这些事件，状态机因此不认任何一家的协议。
 */
export type TurnTimingTick =
  | { type: 'turn-start'; at: number }
  | { type: 'output'; at: number; chars?: number }
  | {
      type: 'tool-start';
      at: number;
      tool?: string;
      callID?: string;
      displayText?: string;
    }
  | { type: 'tool-end'; at: number; callID?: string; status?: TurnTimingToolStatus }
  | { type: 'turn-end'; at: number; outcome: TurnTimingOutcome };

/** 会话里保留多少轮耗时记录（最新的在前，超出丢弃最旧的）。 */
export const MAX_TURN_TIMINGS = 50;

export function createTurnTimingState(): TurnTimingState {
  return {
    startedAt: 0,
    endedAt: 0,
    lastAt: 0,
    segments: [],
    openIndex: -1,
    outcome: null,
  };
}

function lastEnd(segments: TurnTimingSegment[], fallback: number): number {
  const last = segments[segments.length - 1];
  return last ? last.end : fallback;
}

/** 把仍打开的区间收到 `at`：模型输出「延续到工具调用发出」，工具「跑到结果回来」。 */
function closeOpenAt(segments: TurnTimingSegment[], openIndex: number, at: number): TurnTimingSegment[] {
  if (openIndex < 0) return segments;
  const segment = segments[openIndex];
  if (!segment || at <= segment.end) return segments;
  const next = segments.slice();
  next[openIndex] = { ...segment, end: at };
  return next;
}

/** 两个活动区间之间的空档就是「等待模型」：上一段结束 → 这一段开始。 */
function pushWait(segments: TurnTimingSegment[], from: number, to: number): TurnTimingSegment[] {
  if (!(to > from)) return segments;
  return [...segments, { kind: 'wait', start: from, end: to }];
}

function findToolSegment(segments: TurnTimingSegment[], callID: string, openIndex: number): number {
  if (openIndex >= 0) {
    const segment = segments[openIndex];
    if (segment?.kind === 'tool' && (!callID || segment.callID === callID)) return openIndex;
  }
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    if (segment.kind !== 'tool') continue;
    if (segment.status !== 'pending') continue;
    if (!callID || segment.callID === callID) return index;
  }
  return -1;
}

export function applyTurnTimingTick(state: TurnTimingState, tick: TurnTimingTick): TurnTimingState {
  if (!tick || typeof tick.type !== 'string') return state;
  if (tick.type === 'turn-start') {
    return { ...createTurnTimingState(), startedAt: tick.at, lastAt: tick.at };
  }
  if (!state || !state.startedAt) return state;
  const at = tick.at;

  if (tick.type === 'output') {
    const chars = Math.max(0, tick.chars ?? 0);
    const open = state.openIndex >= 0 ? state.segments[state.openIndex] : null;
    if (open?.kind === 'generate') {
      const segments = state.segments.slice();
      const end = Math.max(open.end, at);
      segments[state.openIndex] = { ...open, end, chars: (open.chars ?? 0) + chars };
      return { ...state, segments, lastAt: end };
    }
    let segments = closeOpenAt(state.segments.slice(), state.openIndex, at);
    const idleFrom = lastEnd(segments, state.lastAt);
    segments = pushWait(segments, idleFrom, at);
    segments.push({ kind: 'generate', start: at, end: at, chars });
    return { ...state, segments, openIndex: segments.length - 1, lastAt: at };
  }

  if (tick.type === 'tool-start') {
    const callID = tick.callID || '';
    let segments = closeOpenAt(state.segments.slice(), state.openIndex, at);
    const idleFrom = lastEnd(segments, state.lastAt);
    segments = pushWait(segments, idleFrom, at);
    segments.push({
      kind: 'tool',
      start: at,
      end: at,
      callID,
      tool: tick.tool || '',
      displayText: tick.displayText || '',
      status: 'pending',
    });
    return { ...state, segments, openIndex: segments.length - 1, lastAt: at };
  }

  if (tick.type === 'tool-end') {
    const index = findToolSegment(state.segments, tick.callID || '', state.openIndex);
    if (index < 0) return state;
    const segments = state.segments.slice();
    const segment = segments[index]!;
    const end = Math.max(segment.end, at);
    segments[index] = { ...segment, end, status: tick.status || 'completed' };
    return { ...state, segments, openIndex: -1, lastAt: end };
  }

  if (tick.type === 'turn-end') {
    let segments = closeOpenAt(state.segments.slice(), state.openIndex, at);
    // 收尾时仍没回来的工具（中止 / 出错）如实标在它自己那条上，而不是吞掉。
    if (state.openIndex >= 0) {
      const open = segments[state.openIndex];
      if (open?.kind === 'tool' && open.status === 'pending') {
        // 工具本身只有跑完 / 被中止两种结局：宿主在边界停下时，手上那个还没回来的
        // 工具就是被打断了（下一轮会重跑它）。
        segments[state.openIndex] = { ...open, status: tick.outcome === 'paused' ? 'aborted' : tick.outcome };
      }
    }
    const idleFrom = lastEnd(segments, state.lastAt);
    segments = pushWait(segments, idleFrom, at);
    if (segments.length && segments[segments.length - 1]!.kind === 'wait') {
      const last = segments[segments.length - 1]!;
      segments[segments.length - 1] = { ...last, tail: true };
    }
    return {
      ...state,
      segments,
      openIndex: -1,
      endedAt: at,
      lastAt: at,
      outcome: tick.outcome,
    };
  }

  return state;
}

export type TurnTimingItem = {
  start: number;
  offsetMs: number;
  durationMs: number;
  /** 这一段占整轮的比例（0–1）。 */
  share: number;
  tail: boolean;
  live: boolean;
  tool: string;
  displayText: string;
  status: string;
  chars: number;
};

export type TurnTimingGroup = {
  id: TurnTimingKind;
  items: TurnTimingItem[];
  count: number;
  totalMs: number;
  ratio: number;
};

export type TurnTimingTimelineItem = TurnTimingItem & { kind: TurnTimingKind };

export type TurnTimingToolTotal = { tool: string; count: number; totalMs: number };

export type TurnTimingSummary = {
  startedAt: number;
  endedAt: number;
  totalMs: number;
  running: boolean;
  outcome: TurnTimingOutcome | null;
  groups: TurnTimingGroup[];
  /** 三类各占的整数百分比，三行加起来正好 100（见 {@link groupPercents}）。 */
  percents: number[];
  timeline: TurnTimingTimelineItem[];
  /** 最长的那一段在 `timeline` 里的下标（没有可比的段时为 -1）。 */
  slowestIndex: number;
  slowestMs: number;
  /** 工具按名字聚合，累计耗时降序：十几次短调用里挑出真正的大头。 */
  toolBreakdown: TurnTimingToolTotal[];
  requests: number;
  toolCalls: number;
};

const KIND_ORDER: TurnTimingKind[] = ['wait', 'generate', 'tool'];

/** 同一份工具（`run_shell` 3 次）合并成一行：次数 + 累计耗时，按累计耗时降序。 */
function aggregateTools(items: TurnTimingItem[]): TurnTimingToolTotal[] {
  const totals = new Map<string, TurnTimingToolTotal>();
  for (const item of items) {
    const key = item.tool || 'tool';
    const entry = totals.get(key);
    if (entry) {
      entry.count += 1;
      entry.totalMs += item.durationMs;
    } else {
      totals.set(key, { tool: key, count: 1, totalMs: item.durationMs });
    }
  }
  return [...totals.values()].sort((a, b) => b.totalMs - a.totalMs);
}

/**
 * 聚合出界面要的形态：总耗时、三类合计与占比、按发生顺序的明细。
 * 运行中 `endedAt` 还没有，用当前时刻继续计时。
 */
export function summarizeTurnTiming(
  state: TurnTimingState | null | undefined,
  nowMs = Date.now(),
): TurnTimingSummary | null {
  if (!state?.startedAt) return null;
  const endedAt = state.endedAt || Math.max(nowMs, state.startedAt);
  const totalMs = Math.max(0, endedAt - state.startedAt);
  // 运行中：仍打开的那一段（模型正在输出 / 工具正在跑）算到此刻；没有打开段说明
  // 正等着下一次请求，补一条「进行中」的等待，占比条与总耗时才始终连续。
  const segments = state.segments.map((segment, index) =>
    !state.endedAt && index === state.openIndex ? { ...segment, end: endedAt } : segment,
  );
  if (!state.endedAt && state.openIndex < 0 && endedAt > state.lastAt) {
    segments.push({ kind: 'wait', start: state.lastAt, end: endedAt, live: true });
  }
  const groups = KIND_ORDER.map((kind) => {
    const items: TurnTimingItem[] = [];
    for (const segment of segments) {
      if (segment.kind !== kind) continue;
      const durationMs = Math.max(0, segment.end - segment.start);
      items.push({
        start: segment.start,
        offsetMs: Math.max(0, segment.start - state.startedAt),
        durationMs,
        share: totalMs > 0 ? durationMs / totalMs : 0,
        tail: Boolean(segment.tail),
        live: Boolean(segment.live),
        tool: segment.tool || '',
        displayText: segment.displayText || '',
        status: segment.status || '',
        chars: segment.chars || 0,
      });
    }
    const total = items.reduce((sum, item) => sum + item.durationMs, 0);
    return {
      id: kind,
      items,
      count: items.length,
      totalMs: total,
      ratio: totalMs > 0 ? total / totalMs : 0,
    };
  });
  const timeline: TurnTimingTimelineItem[] = groups
    .flatMap((group) => group.items.map((item) => ({ ...item, kind: group.id })))
    .sort((a, b) => a.start - b.start);
  let slowestIndex = -1;
  let slowestMs = 0;
  timeline.forEach((item, index) => {
    if (item.durationMs <= slowestMs) return;
    slowestMs = item.durationMs;
    slowestIndex = index;
  });
  const wait = groups[0]!;
  const tool = groups[2]!;
  return {
    startedAt: state.startedAt,
    endedAt,
    totalMs,
    running: !state.endedAt,
    outcome: state.outcome,
    groups,
    percents: groupPercents(groups),
    timeline,
    slowestIndex,
    slowestMs,
    toolBreakdown: aggregateTools(tool.items),
    requests: wait.items.filter((item) => !item.tail && !item.live).length,
    toolCalls: tool.items.length,
  };
}

/**
 * 各组的整数百分比：三行加起来必须正好 100%，否则用户会觉得时间被多算或少算了。
 * 舍入的零头记到最费时间的那一类上（`<1%` 的组也参与，它的零头同样归到最大项）。
 */
export function groupPercents(groups: TurnTimingGroup[]): number[] {
  const percents = groups.map((group) => (group.count > 0 ? Math.round(group.ratio * 100) : 0));
  const drift = 100 - percents.reduce((sum, value) => sum + value, 0);
  if (!drift) return percents;
  let heaviest = -1;
  groups.forEach((group, index) => {
    if (!group.count) return;
    if (heaviest < 0 || group.totalMs > groups[heaviest]!.totalMs) heaviest = index;
  });
  if (heaviest >= 0) percents[heaviest] = (percents[heaviest] ?? 0) + drift;
  return percents;
}

/**
 * 落盘形态：只留画图要用的字段（丢掉 callID、tail/live 这类过程标记），
 * 一条记录几十个数字，50 轮也只有几十 KB。
 */
export type TurnTimingRecord = {
  startedAt: number;
  endedAt: number;
  outcome: TurnTimingOutcome;
  segments: {
    kind: TurnTimingKind;
    start: number;
    end: number;
    tool?: string;
    displayText?: string;
    status?: TurnTimingToolStatus;
    chars?: number;
    /** 收尾那条等待（本轮结束前的空档）：不算一次请求，界面也要说清它不是首字等待。 */
    tail?: boolean;
  }[];
};

/** 一轮跑完（或中止 / 出错）后转成落盘形态；还没结束的轮次返回 null。 */
export function turnTimingRecord(state: TurnTimingState | null | undefined): TurnTimingRecord | null {
  if (!state?.startedAt || !state.endedAt) return null;
  const outcome: TurnTimingOutcome = state.outcome ?? 'completed';
  const segments = state.segments
    .filter((segment) => segment.end > segment.start)
    .map((segment) => ({
      kind: segment.kind,
      start: segment.start,
      end: segment.end,
      ...(segment.tool ? { tool: segment.tool } : {}),
      ...(segment.displayText ? { displayText: segment.displayText } : {}),
      ...(segment.status ? { status: segment.status } : {}),
      ...(segment.chars ? { chars: segment.chars } : {}),
      ...(segment.tail ? { tail: true } : {}),
    }));
  return { startedAt: state.startedAt, endedAt: state.endedAt, outcome, segments };
}

/** 把落盘的记录还原成状态机形态，界面与 `summarizeTurnTiming` 因此只认一种输入。 */
export function turnTimingStateFromRecord(record: TurnTimingRecord): TurnTimingState {
  const segments: TurnTimingSegment[] = record.segments.map((segment) => ({
    kind: segment.kind,
    start: segment.start,
    end: segment.end,
    ...(segment.tool ? { tool: segment.tool } : {}),
    ...(segment.displayText ? { displayText: segment.displayText } : {}),
    ...(segment.status ? { status: segment.status } : {}),
    ...(segment.chars ? { chars: segment.chars } : {}),
    ...(segment.tail ? { tail: true } : {}),
  }));
  return {
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    lastAt: record.endedAt,
    segments,
    openIndex: -1,
    outcome: record.outcome,
  };
}

function finite(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function normalizeSegment(value: unknown): TurnTimingRecord['segments'][number] | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  if (kind !== 'wait' && kind !== 'generate' && kind !== 'tool') return null;
  const start = finite(raw.start);
  const end = finite(raw.end);
  if (start == null || end == null || end < start) return null;
  const status = raw.status;
  const toolStatus: TurnTimingToolStatus | undefined =
    status === 'pending' || status === 'completed' || status === 'aborted' || status === 'error' ? status : undefined;
  const chars = Math.max(0, Math.round(Number(raw.chars) || 0));
  return {
    kind,
    start,
    end,
    ...(typeof raw.tool === 'string' && raw.tool ? { tool: raw.tool } : {}),
    ...(typeof raw.displayText === 'string' && raw.displayText ? { displayText: raw.displayText } : {}),
    ...(toolStatus ? { status: toolStatus } : {}),
    ...(chars ? { chars } : {}),
    ...(raw.tail === true ? { tail: true } : {}),
  };
}

/**
 * 读盘清洗：会话文件里的 `turnTimings` 可能是旧版本写的、也可能被人手改过。
 * 坏掉的整条记录直接丢掉，但一条坏记录不该让整份会话被判成损坏——它只影响这一个页签。
 */
export function normalizeTurnTimings(value: unknown): TurnTimingRecord[] {
  if (!Array.isArray(value)) return [];
  const records: TurnTimingRecord[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    const startedAt = finite(raw.startedAt);
    const endedAt = finite(raw.endedAt);
    if (startedAt == null || endedAt == null || endedAt < startedAt) continue;
    const outcome = raw.outcome;
    const segments: TurnTimingRecord['segments'] = [];
    if (Array.isArray(raw.segments)) {
      for (const segment of raw.segments) {
        const normalized = normalizeSegment(segment);
        if (normalized) segments.push(normalized);
      }
    }
    records.push({
      startedAt,
      endedAt,
      outcome: outcome === 'aborted' || outcome === 'error' ? outcome : 'completed',
      segments,
    });
  }
  records.sort((a, b) => a.startedAt - b.startedAt);
  return records.slice(-MAX_TURN_TIMINGS);
}

/** 追加一轮并裁到上限：新的在最后，界面因此拿最后一个当下标默认选中。 */
export function appendTurnTiming(
  records: TurnTimingRecord[] | undefined,
  record: TurnTimingRecord,
  limit = MAX_TURN_TIMINGS,
): TurnTimingRecord[] {
  const next = Array.isArray(records) ? records.slice() : [];
  const previous = next[next.length - 1];
  if (previous && previous.startedAt === record.startedAt) next[next.length - 1] = record;
  else next.push(record);
  return next.length > limit ? next.slice(-limit) : next;
}

/**
 * `/loop` 定时循环任务的参数解析（CLI 交互命令与桌面端 Web Chat 斜杠命令共用）。
 *
 * 两端的 `/loop` 必须接受同一套写法，否则用户要为同一个功能记两种语法，所以解析只此一份：
 * 这里只有不依赖任何运行时的纯函数，调度器、UI 与工具各自实现。
 */

export const MIN_LOOP_INTERVAL_MS = 10_000;
export const DEFAULT_LOOP_INTERVAL_MS = 30 * 60_000;
/**
 * 桌面端用来兜住 `setTimeout` 溢出的间隔上限（一周）。解析本身不限幅（与 CLI 一致），
 * 由调用方决定是否拒收。
 */
export const MAX_LOOP_INTERVAL_MS = 7 * 24 * 3_600_000;

const UNIT_MS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

type Unit = keyof typeof UNIT_MS;

/** 单位别名按「长的在前」排，避免 `30min` 被 `m` 吃掉后剩下一个无法消费的 `in`。 */
const TOKEN_RE = /^(\d+(?:\.\d+)?)\s*(seconds?|secs?|sec|s|minutes?|mins?|min|m|hours?|hrs?|hr|h|days?|day|d)/;

const UNIT_ALIASES: Record<string, Unit> = {
  s: 's',
  sec: 's',
  secs: 's',
  second: 's',
  seconds: 's',
  m: 'm',
  min: 'm',
  mins: 'm',
  minute: 'm',
  minutes: 'm',
  h: 'h',
  hr: 'h',
  hrs: 'h',
  hour: 'h',
  hours: 'h',
  d: 'd',
  day: 'd',
  days: 'd',
};

/**
 * 解析间隔写法：`30m`、`30min`、`1h30m`、`45s`、`2d`、`1.5h`；纯数字按秒（`90` = 90 秒）。
 * 无法整体消费（`60x`、`h1m`、`m`）返回 null。
 */
export function parseLoopDuration(input: string): number | null {
  const trimmed = String(input ?? '').trim().toLowerCase();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1_000);

  let total = 0;
  let rest = trimmed;
  while (rest.length > 0) {
    const match = TOKEN_RE.exec(rest);
    if (!match) return null;
    const unit = UNIT_ALIASES[match[2]];
    if (!unit) return null;
    const value = Number(match[1]);
    if (!Number.isFinite(value)) return null;
    total += value * UNIT_MS[unit];
    rest = rest.slice(match[0].length).trimStart();
  }
  return Math.round(total);
}

export function formatLoopInterval(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.round(hours / 24)} 天`;
}

export type LoopArgsParseResult =
  | { kind: 'start'; intervalMs: number; intervalLabel: string; task: string }
  | { kind: 'stop' }
  | { kind: 'status' }
  | { kind: 'error'; message: string };

export const LOOP_USAGE =
  '用法：/loop <任务描述>（默认每 30 分钟）或 /loop <间隔> <任务描述>，例如 /loop 30min 推送一条新闻';

/**
 * 解析 `/loop` 的命令参数。
 *
 * 第一个词能当间隔用时才把它当间隔，否则整段输入都是任务（所以任务里出现数字不会被误判成间隔）。
 */
export function parseLoopArgs(args: string): LoopArgsParseResult {
  const trimmed = String(args ?? '').trim();
  if (!trimmed) return { kind: 'status' };
  const lower = trimmed.toLowerCase();
  if (['stop', 'off', 'cancel', 'end'].includes(lower)) return { kind: 'stop' };
  if (lower === 'status') return { kind: 'status' };

  const [first, ...rest] = trimmed.split(/\s+/);
  const intervalMs = parseLoopDuration(first ?? '');
  if (intervalMs !== null) {
    const task = rest.join(' ').trim();
    if (!task) return { kind: 'error', message: `缺少任务描述；${LOOP_USAGE}` };
    if (intervalMs < MIN_LOOP_INTERVAL_MS) {
      return { kind: 'error', message: '循环间隔太短，最少 10 秒' };
    }
    return { kind: 'start', intervalMs, intervalLabel: formatLoopInterval(intervalMs), task };
  }

  return {
    kind: 'start',
    intervalMs: DEFAULT_LOOP_INTERVAL_MS,
    intervalLabel: formatLoopInterval(DEFAULT_LOOP_INTERVAL_MS),
    task: trimmed,
  };
}

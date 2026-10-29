/**
 * 把 D-Chat 群公告里的排期读成结构化阶段。
 *
 * 公告是同事手写的自由文本，没有格式约定，所以这里只认两类稳定信号：
 *
 * - 一个已知的阶段词（开发 / 联调 / 提测 / 测试 / 走查 / 上线 / showcase …）；
 * - 同一段里至少一个 `M.D` 或 `M-D` 形式的日期。
 *
 * 阶段词与日期的先后顺序不做假设（「10.15～10.21开发」和「开发：10.15～10.21」都出现过），
 * 段内其它文字一律当噪声丢掉。识别不出来就返回空数组——公告里没有排期是正常情况，
 * 不能让一条解析不了的公告变成一条错误。
 */

/** 阶段的规范顺序与显示名：排期表按它排序，卡片按它上色。 */
export const STAGE_LABELS: Record<string, string> = {
  review: '评审',
  dev: '开发',
  integration: '联调',
  submit: '提测',
  'case-review': 'case 评审',
  testing: '测试',
  acceptance: '验收',
  walkthrough: '走查',
  release: '上线',
  showcase: 'showcase'
};

/** 阶段在时间轴上的先后：同时命中多个阶段词时按它取，避免「测试开发」这类词串味。 */
const STAGE_SEQUENCE = [
  'review',
  'dev',
  'integration',
  'submit',
  'case-review',
  'testing',
  'acceptance',
  'walkthrough',
  'release',
  'showcase'
];

/**
 * 阶段词表。值是规范 key，键是公告里可能出现的写法（长的写在前面，先命中先算）。
 *
 * 「走查上线」「联调&提测」这种合写先按 `+ & 和 及` 拆成两段再各查一次，
 * 所以这里不需要把组合写法穷举出来。
 */
const STAGE_WORDS: Array<[string, string[]]> = [
  ['case-review', ['case评审', 'case 评审', '用例评审']],
  ['review', ['需求评审', '技术评审', '设计评审', '评审']],
  ['integration', ['前后端联调', '联调']],
  ['submit', ['提测']],
  ['testing', ['测试']],
  ['acceptance', ['验收']],
  ['smoke', ['冒烟']],
  ['walkthrough', ['走查', '体验走查']],
  ['release', ['上线', '发布', '灰度']],
  ['showcase', ['showcase', 'SHOWCASE', 'Showcase', '演示']],
  ['dev', ['开发']]
];

/** `M.D` / `M-D` / `M/D`；前后不能紧贴数字，否则会从 URL、单号里切出一截。 */
const DATE_TOKEN = /(?<!\d)(\d{1,2})\s*[.\-/月]\s*(\d{1,2})(?!\d)/g;

/** 一段话里的日期，按出现顺序。 */
function datesIn(text: string): Array<{ month: number; day: number }> {
  const found: Array<{ month: number; day: number }> = [];
  for (const match of text.matchAll(DATE_TOKEN)) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) found.push({ month, day });
  }
  return found;
}

function parseDateOnly(value: string): { year: number; month: number; day: number } {
  const [year, month, day] = value.split('-').map(Number);
  return { year: year!, month: month!, day: day! };
}

function formatDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 公告只写月日，年份要自己补。
 *
 * 规则：先按参考日期那一年算，再看着落点是否离谱。差了十个月以上说明年份跨了边界——
 * 12 月发的公告写「1.5」，同一个年份里它是十个月前；1 月发的公告写「12.28」，同一个
 * 年份里它是十一个月后。这两种各挪一年，其余（包括公告里已经过去的旧日期）保持原年。
 */
function inferYear(
  month: number,
  day: number,
  reference: { year: number; month: number; day: number },
): number {
  const sameYear = Date.UTC(reference.year, month - 1, day) / 86_400_000;
  const today = Date.UTC(reference.year, reference.month - 1, reference.day) / 86_400_000;
  const delta = sameYear - today;
  if (delta > 300) return reference.year - 1;
  if (delta < -300) return reference.year + 1;
  return reference.year;
}

/**
 * 一段文字里的全部阶段 key，按出现位置排序。
 *
 * 命中全部而不是只取一个：「走查上线：11.16」是两个阶段落在同一天，只取第一个会丢掉上线。
 */
function stageKeysIn(text: string): string[] {
  const lower = text.toLowerCase();
  const hits: Array<{ key: string; index: number; end: number }> = [];
  for (const [key, words] of STAGE_WORDS) {
    for (const word of words) {
      const index = lower.indexOf(word.toLowerCase());
      if (index < 0) continue;
      hits.push({ key, index, end: index + word.length });
      break;
    }
  }
  // 长词吃掉被它包住的短词：「case评审」同时命中 case-review 与 review，
  // 但那是同一个阶段，不能算两行排期。
  const kept = hits.filter(
    (hit) => !hits.some((other) => other !== hit && other.index <= hit.index && other.end >= hit.end),
  );
  kept.sort((left, right) => left.index - right.index);
  return [...new Set(kept.map((hit) => hit.key))];
}

/** 去掉日期与标点后剩下的标签文本。 */
function stripDates(segment: string): string {
  return segment
    .replace(DATE_TOKEN, ' ')
    .replace(/[～~—–]/g, ' ')
    .replace(/^[\s:：\-—,，、.。()（）[\]【】]+|[\s:：\-—,，、.。()（）[\]【】]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 一段里的多个阶段词：「走查上线」「联调&提测」「开发+联调」。
 *
 * 拆不开的组合（「测试联调」这种连写）就按最先出现的那个词算一个阶段——
 * 猜错一个日期比丢掉整条排期更糟。
 */
function stagesInLabel(label: string): string[] {
  const parts = label
    .split(/[+＋&＆/、和及与]/)
    .map((part) => part.trim())
    .filter(Boolean);
  return [...new Set(parts.flatMap(stageKeysIn))];
}

export type ScheduleStage = {
  /** 规范阶段 key（见 `STAGE_LABELS`）。 */
  key: string;
  /** 公告里的原样写法，显示用（「联调」「case 评审」）。 */
  label: string;
  /** 最早一天，`YYYY-MM-DD`。 */
  start: string;
  /** 最晚一天，`YYYY-MM-DD`。 */
  end: string;
  /** 公告里写出的全部日期；不连续的写法（「10.30、11.2」）靠它还原。 */
  days: string[];
  /**
   * 公告写的是连续区间（`10.28-10.30`）还是一串日子（`10.30、11.2`）。
   *
   * 只有日期本身区分不出来：「10.28-10.30」的两个端点差两天却要显示成区间，
   * 所以解析时就得记住原文用的是分隔符还是顿号。
   */
  range: boolean;
};

/**
 * 解析一段公告正文。
 *
 * 返回的多个阶段可能重叠（测试跨过上线是常事），调用方按日期聚合即可，这里不做裁剪。
 */
export function parseSchedule(
  text: string,
  options: { reference: string },
): ScheduleStage[] {
  if (!text.trim()) return [];
  const reference = parseDateOnly(options.reference);
  const stages: ScheduleStage[] = [];

  for (const raw of text.split(/[\n\r，,；;]/)) {
    const segment = raw.trim();
    if (!segment) continue;
    const matches = [...segment.matchAll(DATE_TOKEN)];
    const dates = datesIn(segment);
    if (dates.length === 0) continue;
    const label = stripDates(segment);
    if (!label) continue;
    const keys = stagesInLabel(label);
    if (keys.length === 0) continue;

    // 两个日期之间是顿号（或段内的逗号）就是并列的几天，否则当连续区间
    const listed = matches.some((match, index) => {
      const next = matches[index + 1];
      if (!next) return false;
      const gap = segment.slice((match.index ?? 0) + match[0].length, next.index);
      return gap.includes('、');
    });

    const days = [
      ...new Set(
        dates.map((date) => formatDate(inferYear(date.month, date.day, reference), date.month, date.day)),
      ),
    ].sort();
    for (const key of keys) {
      stages.push({
        key,
        label: STAGE_LABELS[key] ?? label,
        start: days[0]!,
        end: days[days.length - 1]!,
        days: [...days],
        range: !listed
      });
    }
  }

  return stages.sort((left, right) => left.start.localeCompare(right.start));
}

/* ------------------------------------------------------------------ 议程 */

/** 卡片上的一行：某个群的某个阶段，落在哪一天、现在跑到哪一步。 */
export type AgendaItem = {
  groupId: string;
  groupName: string;
  key: string;
  label: string;
  start: string;
  end: string;
  /** 同 `ScheduleStage.range`：连续区间还是一串日子。 */
  range: boolean;
  /** 相对今天的天数，负数表示已经过去。 */
  startIn: number;
  endIn: number;
  /** 阶段总天数（含首尾）；离散写法按整段区间算，`days` 才是真正写出来的那些天。 */
  span: number;
  /** 今天是第几天（1 起），不在区间内时为 0。 */
  dayIndex: number;
};

export type AgendaGroup = {
  id: string;
  name: string;
  stages: ScheduleStage[];
};

function dayNumber(date: string): number {
  const { year, month, day } = parseDateOnly(date);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

/** 两个 `YYYY-MM-DD` 之间差多少天。 */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/**
 * 把各群的阶段摊成「今天在做什么 / 接下来有什么」。
 *
 * 只看窗口内的：已经结束的阶段不再出现（回顾由详情负责），超过 `horizonDays` 的也不出现
 * ——侧栏卡片是一张「现在该看什么」，不是项目台账。
 */
export function buildAgenda(
  groups: AgendaGroup[],
  options: { today: string; horizonDays?: number },
): { active: AgendaItem[]; upcoming: AgendaItem[] } {
  const horizon = options.horizonDays ?? 14;
  const active: AgendaItem[] = [];
  const upcoming: AgendaItem[] = [];

  for (const group of groups) {
    for (const stage of group.stages) {
      const startIn = daysBetween(options.today, stage.start);
      const endIn = daysBetween(options.today, stage.end);
      if (endIn < 0) continue;
      const span = daysBetween(stage.start, stage.end) + 1;
      if (startIn <= 0) {
        const offset = -startIn;
        active.push({
          groupId: group.id,
          groupName: group.name,
          key: stage.key,
          label: stage.label,
          start: stage.start,
          end: stage.end,
          range: stage.range,
          startIn,
          endIn,
          span,
          dayIndex: Math.min(offset + 1, span)
        });
        continue;
      }
      if (startIn > horizon) continue;
      upcoming.push({
        groupId: group.id,
        groupName: group.name,
        key: stage.key,
        label: stage.label,
        start: stage.start,
        end: stage.end,
        range: stage.range,
        startIn,
        endIn,
        span,
        dayIndex: 0
      });
    }
  }

  // 「今天」先按结束日近的排（今天就要收尾的最急），再看阶段顺序；
  // 「接下来」按开始日排，同一天里上线类排前面。
  const stageRank = (key: string): number => {
    const index = STAGE_SEQUENCE.indexOf(key);
    return index < 0 ? STAGE_SEQUENCE.length : index;
  };
  active.sort(
    (left, right) =>
      left.endIn - right.endIn || stageRank(left.key) - stageRank(right.key) || left.groupName.localeCompare(right.groupName),
  );
  upcoming.sort(
    (left, right) =>
      left.startIn - right.startIn ||
      Number(right.key === 'release') - Number(left.key === 'release') ||
      stageRank(left.key) - stageRank(right.key),
  );

  return { active, upcoming };
}

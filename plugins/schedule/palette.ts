/**
 * 任务的颜色。
 *
 * 颜色不只是装饰：同色的任务排在甘特图的同一行（参考项目也是这么分组的）。所以颜色是
 * 数据的一部分，读写都要过 `normalizeColor`，不能由名字临时猜。
 *
 * 这个文件也被渲染层直接用，所以不能 import 任何 node 模块；给界面用的 class 必须是
 * 完整字符串，Tailwind 才扫得到。
 */

export const COLOR_KEYS = ['blue', 'violet', 'emerald', 'amber', 'rose', 'cyan', 'slate'] as const;

export type ScheduleColor = (typeof COLOR_KEYS)[number];

export type ColorMeta = {
  /** 给用户看的中文名 */
  label: string;
  /** 颜色选择器里的圆点 */
  dot: string;
  /** 任务条的底色与描边（正文统一用 fg-max，亮暗主题都能看清） */
  bar: string;
};

export const COLOR_META: Record<ScheduleColor, ColorMeta> = {
  blue: { label: '蓝色', dot: 'bg-sky-500', bar: 'border-sky-500/45 bg-sky-500/18 text-fg-max' },
  violet: { label: '紫色', dot: 'bg-violet-500', bar: 'border-violet-500/45 bg-violet-500/18 text-fg-max' },
  emerald: { label: '绿色', dot: 'bg-emerald-500', bar: 'border-emerald-500/45 bg-emerald-500/18 text-fg-max' },
  amber: { label: '橙色', dot: 'bg-amber-500', bar: 'border-amber-500/45 bg-amber-500/18 text-fg-max' },
  rose: { label: '红色', dot: 'bg-rose-500', bar: 'border-rose-500/45 bg-rose-500/18 text-fg-max' },
  cyan: { label: '青色', dot: 'bg-cyan-500', bar: 'border-cyan-500/45 bg-cyan-500/18 text-fg-max' },
  slate: { label: '灰色', dot: 'bg-slate-500', bar: 'border-slate-500/45 bg-slate-500/18 text-fg-max' },
};

export function isScheduleColor(value: unknown): value is ScheduleColor {
  return typeof value === 'string' && (COLOR_KEYS as readonly string[]).includes(value);
}

/** 认不出的颜色落回蓝色：一份被手改坏的 JSON 不该让整条任务消失。 */
export function normalizeColor(value: unknown): ScheduleColor {
  return isScheduleColor(value) ? value : 'blue';
}

/** 新建任务时按顺序换色，让第一屏看起来不是一片蓝。 */
export function nextColor(index: number): ScheduleColor {
  return COLOR_KEYS[((index % COLOR_KEYS.length) + COLOR_KEYS.length) % COLOR_KEYS.length]!;
}

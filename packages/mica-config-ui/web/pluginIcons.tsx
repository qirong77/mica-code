import type { LucideIcon } from 'lucide-react';
import {
  Archive,
  Blocks,
  Bot,
  Brain,
  Cable,
  Compass,
  Cpu,
  Database,
  FileText,
  GitBranch,
  GitCommit,
  Globe,
  HeartPulse,
  Layers,
  Lightbulb,
  ListChecks,
  MessageSquare,
  MousePointerClick,
  NotebookPen,
  Package,
  Puzzle,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Tags,
  Terminal,
  TextCursorInput,
  Wrench,
  Zap,
} from 'lucide-react';

/**
 * 插件图标表：`plugin.json` 的 `icon` 写这里的键（kebab-case），界面据此取图标组件。
 *
 * 清单里存的是名字而不是组件：插件是数据 + 入口，配置页和桌面端各自打包图标库，只有名字是
 * 两端都能读的约定。表是封闭的——不认识的名称回退到 `DEFAULT_PLUGIN_ICON`，而不是让页面
 * 去猜一个图标库里的任意符号。新增图标 = 在这里登记一行。
 */
export const PLUGIN_ICONS = {
  archive: Archive,
  blocks: Blocks,
  bot: Bot,
  brain: Brain,
  cable: Cable,
  compass: Compass,
  cpu: Cpu,
  database: Database,
  'file-text': FileText,
  'git-branch': GitBranch,
  'git-commit': GitCommit,
  globe: Globe,
  'heart-pulse': HeartPulse,
  layers: Layers,
  lightbulb: Lightbulb,
  'list-checks': ListChecks,
  'message-square': MessageSquare,
  'mouse-pointer-click': MousePointerClick,
  'notebook-pen': NotebookPen,
  package: Package,
  puzzle: Puzzle,
  search: Search,
  'settings-2': Settings2,
  'shield-check': ShieldCheck,
  sparkles: Sparkles,
  tags: Tags,
  terminal: Terminal,
  'text-cursor-input': TextCursorInput,
  wrench: Wrench,
  zap: Zap,
} satisfies Record<string, LucideIcon>;

export type PluginIconName = keyof typeof PLUGIN_ICONS;

/** 清单没声明 `icon`（或写了不认识的名称）时用的图标。 */
export const DEFAULT_PLUGIN_ICON: PluginIconName = 'blocks';

export function resolvePluginIcon(name: string | undefined): LucideIcon {
  const key = (name || '').trim();
  return PLUGIN_ICONS[key as PluginIconName] ?? PLUGIN_ICONS[DEFAULT_PLUGIN_ICON];
}

type PluginIconProps = {
  name?: string;
  size?: number;
  strokeWidth?: number;
  className?: string;
};

/** 插件图标：插件页的卡片、详情页与桌面端插件菜单共用这一份取法。 */
export function PluginIcon({ name, size = 16, strokeWidth = 1.8, className }: PluginIconProps) {
  const Icon = resolvePluginIcon(name);
  return <Icon size={size} strokeWidth={strokeWidth} className={className} aria-hidden="true" />;
}

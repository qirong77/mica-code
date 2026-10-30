import type { ConfigWebSection } from '../../src/shared/types.js';
import { appIcons } from '../icons.js';
import { hasConfigWebThemeHost } from '../theme.js';
// 品牌标志全仓库只有一份（apps/desktop/resources/icon.svg），这里直接引用，不要另存副本。
import markUrl from '../../../../apps/desktop/resources/icon.svg?url&no-inline';

export type ConfigWebAppSection = ConfigWebSection;

type SidebarEntry = { key: ConfigWebAppSection; label: string; available?: () => boolean };

type SidebarGroup = { key: string; label?: string; items: SidebarEntry[] };

// 分组按「这条设置改的是谁」排：先说清楚 agent 是什么（能力、提示词、工具来源），
// 再说会话数据，最后才是只有桌面运行时才有的能力与诊断。原先是 11 个入口平铺，顺序
// 既不是字母序也不是使用频次，读的人要在整列里找。
//
// 带 `available` 的条目由宿主能力决定是否出现（Appearance 依赖宿主注册的主题能力）。
//
// Browser Control 与 Terminal Control **刻意不带这个门控**：它们是「Mica 里有一套能真正
// 打开的浏览器 / 终端」这件事的唯一说明处，藏起来会让人以为 Mica 没有这个能力。服务没开
// 时页面自己说清楚（见 pages/BrowserControlPage.tsx 与 browserControl.ts 的
// unavailableBrowserControlDetails）。Performance 同理：入口始终在，拿不到数据由页面说明。
const groups: SidebarGroup[] = [
  {
    key: 'general',
    items: [
      { key: 'config', label: 'Config' },
      // 主题能力由宿主注册；没注册时这一页不出现（不给点了没反应的单选）。
      { key: 'appearance', label: 'Appearance', available: hasConfigWebThemeHost },
    ],
  },
  {
    key: 'agent',
    label: 'Agent',
    items: [
      { key: 'capabilities', label: 'Capabilities' },
      { key: 'skills', label: 'Skills' },
      { key: 'mcp', label: 'MCP' },
      { key: 'roles', label: 'Roles' },
      { key: 'plugins', label: 'Plugins' },
    ],
  },
  {
    key: 'sessions',
    label: 'Sessions',
    items: [{ key: 'sessions', label: 'Sessions' }],
  },
  {
    key: 'desktop',
    label: 'Desktop',
    items: [
      { key: 'browserControl', label: 'Browser Control' },
      { key: 'terminalControl', label: 'Terminal Control' },
    ],
  },
  {
    key: 'diagnostics',
    label: 'Diagnostics',
    items: [{ key: 'performance', label: 'Performance' }],
  },
];

type SidebarProps = {
  section: ConfigWebAppSection;
  onChange(section: ConfigWebAppSection): void;
  /**
   * 回到应用（桌面端把配置页当整页打开时由宿主提供）。
   *
   * 有这个按钮，设置页才是「从对话里进来的一页」，而不是一个关不掉的面板；浏览器宿主
   * 没有上层界面可回，不传即可。
   */
  onClose?(): void;
  /** 「回到应用」的文案，默认「返回应用」。 */
  closeLabel?: string;
};

export function Sidebar({ section, onChange, onClose, closeLabel = '返回应用' }: SidebarProps) {
  const BackIcon = appIcons.chevronLeft;
  // 宿主拿不到数据的整组直接不渲染，不留一个只有标题的空组。
  const visibleGroups = groups
    .map((group) => ({ ...group, items: group.items.filter((item) => !item.available || item.available()) }))
    .filter((group) => group.items.length > 0);
  return (
    <aside className="sidebar">
      {onClose ? (
        <button type="button" className="sidebar-back" title={closeLabel} onClick={onClose}>
          <BackIcon size={14} aria-hidden="true" />
          <span>{closeLabel}</span>
        </button>
      ) : null}
      <div className="brand-block">
        <MicaMark />
        <div className="brand">Mica</div>
        <span className="brand-tag">设置</span>
      </div>
      <nav className="nav-menu">
        {visibleGroups.map((group) => (
          <div
            key={group.key}
            className="nav-group"
            role="group"
            aria-labelledby={group.label ? `nav-group-${group.key}` : undefined}
          >
            {group.label ? (
              <div className="nav-group-label" id={`nav-group-${group.key}`}>
                {group.label}
              </div>
            ) : null}
            {group.items.map((item) => (
              <SidebarItem
                key={item.key}
                currentSection={section}
                section={item.key}
                label={item.label}
                onChange={onChange}
              />
            ))}
          </div>
        ))}
      </nav>
      {/* 底部固定提示：这一页没有保存按钮，先把这件事说在前面（各页都是改动停下就写盘）。 */}
      <div className="sidebar-foot">
        <span className="sidebar-foot-dot" aria-hidden="true" />
        <span>改动会自动保存</span>
      </div>
    </aside>
  );
}

function MicaMark() {
  return <img className="brand-mark" src={markUrl} alt="Mica" />;
}

function SidebarItem({
  currentSection,
  section,
  label,
  onChange,
}: {
  currentSection: ConfigWebAppSection;
  section: ConfigWebAppSection;
  label: string;
  onChange(section: ConfigWebAppSection): void;
}) {
  const Icon = appIcons[section];
  const active = currentSection === section;
  return (
    <button className={`nav-item ${active ? 'nav-item-active' : ''}`} type="button" onClick={() => onChange(section)}>
      <span className="nav-icon">
        <Icon size={14} strokeWidth={2} />
      </span>
      <span className="nav-label">{label}</span>
    </button>
  );
}

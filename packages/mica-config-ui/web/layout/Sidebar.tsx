import type { ConfigWebSection } from '../../src/shared/types.js';
import { supportsAutoCompact } from '../api.js';
import { appIcons } from '../icons.js';
// 品牌标志全仓库只有一份（apps/desktop/resources/icon.svg），这里直接引用，不要另存副本。
import markUrl from '../../../../apps/desktop/resources/icon.svg?url&no-inline';

export type ConfigWebAppSection = ConfigWebSection;

// `desktopOnly` 的条目由宿主能力决定是否出现：自动压缩的设置与计数活在运行时的
// userData 里，浏览器宿主（apps/config-web）拿不到，所以那一边连入口都不显示。
const items = [
  { key: 'config', label: 'Config' },
  { key: 'autoCompact', label: 'Auto Compact', desktopOnly: true },
  { key: 'sessions', label: 'Sessions' },
  { key: 'roles', label: 'Roles' },
  { key: 'mcp', label: 'MCP' },
  { key: 'skills', label: 'Skills' },
  { key: 'plugins', label: 'Plugins' },
] satisfies Array<{ key: ConfigWebAppSection; label: string; desktopOnly?: boolean }>;

type SidebarProps = {
  section: ConfigWebAppSection;
  onChange(section: ConfigWebAppSection): void;
};

export function Sidebar({ section, onChange }: SidebarProps) {
  const visibleItems = items.filter((item) => !item.desktopOnly || supportsAutoCompact());
  return (
    <aside className="sidebar">
      <div className="brand-block">
        <MicaMark />
        <div className="brand">Mica</div>
      </div>
      <nav className="nav-menu">
        {visibleItems.map((item) => (
          <SidebarItem
            key={item.key}
            currentSection={section}
            section={item.key}
            label={item.label}
            onChange={onChange}
          />
        ))}
      </nav>
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

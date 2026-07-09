import type { ConfigWebSection } from '../../../src/shared/types.js';
import { sectionLabels } from '../dashboardData.js';
import { appIcons } from '../icons.js';

const items = [
  { key: 'config' },
  { key: 'mcp' },
  { key: 'skills' },
  { key: 'plugins' },
];

type SidebarProps = {
  section: ConfigWebSection;
  onChange(section: ConfigWebSection): void;
};

export function Sidebar({ section, onChange }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand-block">
        <div>
          <div className="brand">Mica</div>
        </div>
      </div>
      <nav className="nav-menu">
        {items.map((item) => (
          <SidebarItem key={item.key} currentSection={section} section={item.key as ConfigWebSection} onChange={onChange} />
        ))}
      </nav>
    </aside>
  );
}

function SidebarItem({ currentSection, section, onChange }: { currentSection: ConfigWebSection; section: ConfigWebSection; onChange(section: ConfigWebSection): void }) {
  const Icon = appIcons[section];
  const active = currentSection === section;
  return (
    <button className={`nav-item ${active ? 'nav-item-active' : ''}`} type="button" onClick={() => onChange(section)}>
      <span className="nav-icon">
        <Icon size={16} strokeWidth={2} />
      </span>
      <span className="nav-label">{sectionLabels[section]}</span>
    </button>
  );
}

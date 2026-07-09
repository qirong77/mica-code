import type { ConfigWebSection } from '../../../src/shared/types.js';
import { appIcons } from '../icons.js';

const items = [
  { key: 'config', label: 'Config' },
  { key: 'mcp', label: 'MCP' },
  { key: 'skills', label: 'Skills' },
  { key: 'plugins', label: 'Plugins' },
] satisfies Array<{ key: ConfigWebSection; label: string }>;

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
          <SidebarItem key={item.key} currentSection={section} section={item.key} label={item.label} onChange={onChange} />
        ))}
      </nav>
    </aside>
  );
}

function SidebarItem({ currentSection, section, label, onChange }: { currentSection: ConfigWebSection; section: ConfigWebSection; label: string; onChange(section: ConfigWebSection): void }) {
  const Icon = appIcons[section];
  const active = currentSection === section;
  return (
    <button className={`nav-item ${active ? 'nav-item-active' : ''}`} type="button" onClick={() => onChange(section)}>
      <span className="nav-icon">
        <Icon size={16} strokeWidth={2} />
      </span>
      <span className="nav-label">{label}</span>
    </button>
  );
}

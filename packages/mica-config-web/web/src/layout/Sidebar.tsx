import type { ConfigWebSection } from '../../../src/shared/types.js';

const items = [
  { key: 'config', icon: '{}', label: 'Config' },
  { key: 'mcp', icon: '<>', label: 'MCP' },
  { key: 'skills', icon: '#', label: 'Skills' },
  { key: 'plugins', icon: '+', label: 'Plugins' },
];

type SidebarProps = {
  section: ConfigWebSection;
  onChange(section: ConfigWebSection): void;
};

export function Sidebar({ section, onChange }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand">Mica</div>
      <nav className="nav-menu">
        {items.map((item) => (
          <button
            className={`nav-item ${section === item.key ? 'nav-item-active' : ''}`}
            key={item.key}
            type="button"
            onClick={() => onChange(item.key as ConfigWebSection)}
          >
            <span className="nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}

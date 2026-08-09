import type { ConfigWebSection } from '../../../src/shared/types.js';
import { appIcons } from '../icons.js';

export type ConfigWebAppSection = ConfigWebSection;

const items = [
  { key: 'config', label: 'Config' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'roles', label: 'Roles' },
  { key: 'mcp', label: 'MCP' },
  { key: 'skills', label: 'Skills' },
  { key: 'plugins', label: 'Plugins' },
  { key: 'sync', label: 'Sync' },
] satisfies Array<{ key: ConfigWebAppSection; label: string }>;

type SidebarProps = {
  section: ConfigWebAppSection;
  onChange(section: ConfigWebAppSection): void;
};

export function Sidebar({ section, onChange }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand-block">
        <MicaMark />
        <div className="brand">Mica</div>
      </div>
      <nav className="nav-menu">
        {items.map((item) => (
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
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" role="img" aria-label="Mica">
      <rect width="32" height="32" rx="7" fill="currentColor" />
      <path d="M8 22V10h3.2l4.8 6.5 4.8-6.5H24v12h-3.2v-6.7L16 21.5l-4.8-6.2V22H8z" fill="var(--bg)" />
    </svg>
  );
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

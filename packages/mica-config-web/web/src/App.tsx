import { useEffect, useState } from 'react';
import { Sidebar } from './layout/Sidebar.js';
import { ConfigPage } from './pages/ConfigPage.js';
import { McpPage } from './pages/McpPage.js';
import { PluginsPage } from './pages/PluginsPage.js';
import { SkillsPage } from './pages/SkillsPage.js';
import { connectHeartbeat } from './api.js';
import type { ConfigWebSection } from '../../src/shared/types.js';
import { dashboardMetrics, sectionDescriptions, sectionLabels } from './dashboardData.js';

export function App() {
  const [section, setSection] = useState<ConfigWebSection>('config');

  useEffect(() => {
    const socket = connectHeartbeat();
    return () => socket?.close();
  }, []);

  return (
    <main className="app-shell">
      <Sidebar section={section} onChange={setSection} />
      <div className="content-shell">
        <header className="topbar">
          <div>
            <p className="topbar-label">Mica Config Center</p>
            <h2>{sectionLabels[section]}</h2>
          </div>
          <div className="topbar-meta">
            <div className="topbar-pill">
              <span>Current view</span>
              <strong>{sectionLabels[section]}</strong>
            </div>
            <div className="topbar-pill topbar-pill-muted">{sectionDescriptions[section]}</div>
          </div>
        </header>
        <section className="overview-strip" aria-label="workspace overview">
          {dashboardMetrics.map((item) => (
            <article className="overview-card" key={item.label}>
              <span className="overview-label">{item.label}</span>
              <strong className="overview-value">{item.value}</strong>
              <span className="overview-trend">{item.trend}</span>
              <p className="overview-detail">{item.detail}</p>
            </article>
          ))}
        </section>
        {section === 'config' ? <ConfigPage /> : null}
        {section === 'mcp' ? <McpPage /> : null}
        {section === 'skills' ? <SkillsPage /> : null}
        {section === 'plugins' ? <PluginsPage /> : null}
      </div>
    </main>
  );
}

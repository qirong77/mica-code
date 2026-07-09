import { useEffect, useState } from 'react';
import { Sidebar } from './layout/Sidebar.js';
import { ConfigPage } from './pages/ConfigPage.js';
import { McpPage } from './pages/McpPage.js';
import { PluginsPage } from './pages/PluginsPage.js';
import { SkillsPage } from './pages/SkillsPage.js';
import { connectHeartbeat, readOverview } from './api.js';
import type { ConfigWebOverviewCard, ConfigWebSection } from '../../src/shared/types.js';
import { fallbackOverviewCards, sectionDescriptions, sectionLabels } from './dashboardData.js';

export function App() {
  const [section, setSection] = useState<ConfigWebSection>('config');
  const [overviewCards, setOverviewCards] = useState<ConfigWebOverviewCard[]>(fallbackOverviewCards);

  useEffect(() => {
    const socket = connectHeartbeat();
    return () => socket?.close();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void readOverview()
      .then((payload) => {
        if (!cancelled) setOverviewCards(payload.cards);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
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
          {overviewCards.map((item) => (
            <article className="overview-card" key={item.label}>
              <span className="overview-label">{item.label}</span>
              <strong className="overview-value">{item.value}</strong>
              {item.trend ? <span className="overview-trend">{item.trend}</span> : null}
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

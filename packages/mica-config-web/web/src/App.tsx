import { useEffect, useState } from 'react';
import { Sidebar, type ConfigWebAppSection } from './layout/Sidebar.js';
import { ConfigPage } from './pages/ConfigPage.js';
import { McpPage } from './pages/McpPage.js';
import { PluginsPage } from './pages/PluginsPage.js';
import { RolesPage } from './pages/RolesPage.js';
import { SessionsPage } from './pages/SessionsPage.js';
import { SkillsPage } from './pages/SkillsPage.js';
import { SyncPage } from './pages/SyncPage.js';
import { connectHeartbeat } from './api.js';

export function App() {
  const [section, setSection] = useState<ConfigWebAppSection>(readInitialSection);
  const [dirtySection, setDirtySection] = useState<ConfigWebAppSection | null>(null);

  function changeSection(nextSection: ConfigWebAppSection) {
    if (dirtySection && dirtySection !== nextSection && !window.confirm('当前页面有未保存的修改，确定要离开吗？')) {
      return;
    }
    setSection(nextSection);
    const url = new URL(window.location.href);
    url.searchParams.set('section', nextSection);
    window.history.replaceState(null, '', url);
  }

  function handleDirtyChange(current: ConfigWebAppSection, dirty: boolean) {
    setDirtySection((prev) => {
      if (dirty) return current;
      return prev === current ? null : prev;
    });
  }

  useEffect(() => {
    const socket = connectHeartbeat();
    return () => socket?.close();
  }, []);

  return (
    <main className="app-shell">
      <Sidebar section={section} onChange={changeSection} />
      <div className="content-shell">
        {section === 'config' ? <ConfigPage /> : null}
        {section === 'sessions' ? (
          <SessionsPage onDirtyChange={(dirty) => handleDirtyChange('sessions', dirty)} />
        ) : null}
        {section === 'roles' ? <RolesPage onDirtyChange={(dirty) => handleDirtyChange('roles', dirty)} /> : null}
        {section === 'mcp' ? <McpPage onDirtyChange={(dirty) => handleDirtyChange('mcp', dirty)} /> : null}
        {section === 'skills' ? <SkillsPage onDirtyChange={(dirty) => handleDirtyChange('skills', dirty)} /> : null}
        {section === 'plugins' ? <PluginsPage /> : null}
        {section === 'sync' ? <SyncPage /> : null}
      </div>
    </main>
  );
}

function readInitialSection(): ConfigWebAppSection {
  const candidate = new URLSearchParams(window.location.search).get('section');
  return candidate && ['config', 'sessions', 'roles', 'mcp', 'skills', 'plugins', 'sync'].includes(candidate)
    ? (candidate as ConfigWebAppSection)
    : 'config';
}

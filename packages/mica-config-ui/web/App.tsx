import { useEffect, useState } from 'react';
import { DialogHost } from './components/DialogHost.js';
import { Sidebar, type ConfigWebAppSection } from './layout/Sidebar.js';
import { CapabilitiesPage } from './pages/CapabilitiesPage.js';
import { ConfigPage } from './pages/ConfigPage.js';
import { BrowserControlPage } from './pages/BrowserControlPage.js';
import { McpPage } from './pages/McpPage.js';
import { PluginsPage } from './pages/PluginsPage.js';
import { RolesPage } from './pages/RolesPage.js';
import { SessionsPage } from './pages/SessionsPage.js';
import { SkillsPage } from './pages/SkillsPage.js';
import { TerminalControlPage } from './pages/TerminalControlPage.js';
import { PerformancePage } from './pages/PerformancePage.js';
import { connectHeartbeat } from './api.js';

export function App() {
  const [section, setSection] = useState<ConfigWebAppSection>(readInitialSection);

  /**
   * 各页都是自动保存，切页面不用问「要不要放弃修改」；页面卸载时自己的 hook 会把最后
   * 一批改动发出去。
   */
  function changeSection(nextSection: ConfigWebAppSection) {
    setSection(nextSection);
    const url = new URL(window.location.href);
    url.searchParams.set('section', nextSection);
    window.history.replaceState(null, '', url);
  }

  useEffect(() => {
    const socket = connectHeartbeat();
    return () => socket?.close();
  }, []);

  return (
    <div className="mica-config-ui">
      <main className="app-shell">
        <Sidebar section={section} onChange={(next) => void changeSection(next)} />
        <div className="content-shell">
          {section === 'config' ? <ConfigPage onNavigate={(next) => void changeSection(next)} /> : null}
          {section === 'browserControl' ? <BrowserControlPage /> : null}
          {section === 'terminalControl' ? <TerminalControlPage /> : null}
          {section === 'performance' ? <PerformancePage /> : null}
          {section === 'sessions' ? <SessionsPage /> : null}
          {section === 'roles' ? <RolesPage /> : null}
          {section === 'mcp' ? <McpPage /> : null}
          {section === 'skills' ? <SkillsPage /> : null}
          {section === 'capabilities' ? <CapabilitiesPage /> : null}
          {section === 'plugins' ? <PluginsPage /> : null}
        </div>
      </main>
      <DialogHost />
    </div>
  );
}

function readInitialSection(): ConfigWebAppSection {
  const candidate = new URLSearchParams(window.location.search).get('section');
  return isSectionAvailable(candidate) ? (candidate as ConfigWebAppSection) : 'config';
}

/**
 * 深链里的 section 必须真的存在，否则退回 Config（Browser Control 的入口各处都在，
 * 拿不到服务时页面自己说明未开启）。
 */
function isSectionAvailable(candidate: string | null): boolean {
  if (!candidate) return false;
  const known: ConfigWebAppSection[] = [
    'config',
    'browserControl',
    'terminalControl',
    'performance',
    'sessions',
    'roles',
    'mcp',
    'skills',
    'capabilities',
    'plugins',
  ];
  if (!known.includes(candidate as ConfigWebAppSection)) return false;
  return true;
}

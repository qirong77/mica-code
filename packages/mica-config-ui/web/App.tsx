import { useEffect, useState } from 'react';
import { DialogHost, confirmDialog } from './components/DialogHost.js';
import { Sidebar, type ConfigWebAppSection } from './layout/Sidebar.js';
import { ConfigPage } from './pages/ConfigPage.js';
import { AutoCompactPage } from './pages/AutoCompactPage.js';
import { BrowserControlPage } from './pages/BrowserControlPage.js';
import { McpPage } from './pages/McpPage.js';
import { PluginsPage } from './pages/PluginsPage.js';
import { RolesPage } from './pages/RolesPage.js';
import { SessionsPage } from './pages/SessionsPage.js';
import { SkillsPage } from './pages/SkillsPage.js';
import { connectHeartbeat, supportsAutoCompact } from './api.js';

export function App() {
  const [section, setSection] = useState<ConfigWebAppSection>(readInitialSection);
  const [dirtySection, setDirtySection] = useState<ConfigWebAppSection | null>(null);

  async function changeSection(nextSection: ConfigWebAppSection) {
    if (dirtySection && dirtySection !== nextSection) {
      const confirmed = await confirmDialog({
        title: '放弃未保存的修改',
        message: '当前页面有未保存的修改，确定要离开吗？',
        confirmText: '离开',
        danger: true,
      });
      if (!confirmed) return;
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
    <div className="mica-config-ui">
      <main className="app-shell">
        <Sidebar section={section} onChange={(next) => void changeSection(next)} />
        <div className="content-shell">
          {section === 'config' ? <ConfigPage /> : null}
          {section === 'autoCompact' ? <AutoCompactPage /> : null}
          {section === 'browserControl' ? <BrowserControlPage /> : null}
          {section === 'sessions' ? (
            <SessionsPage onDirtyChange={(dirty) => handleDirtyChange('sessions', dirty)} />
          ) : null}
          {section === 'roles' ? <RolesPage onDirtyChange={(dirty) => handleDirtyChange('roles', dirty)} /> : null}
          {section === 'mcp' ? <McpPage onDirtyChange={(dirty) => handleDirtyChange('mcp', dirty)} /> : null}
          {section === 'skills' ? <SkillsPage onDirtyChange={(dirty) => handleDirtyChange('skills', dirty)} /> : null}
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
 * 深链里的 section 必须在当前宿主里真的存在，否则退回 Config（浏览器宿主没有 Auto Compact
 * 的数据；Browser Control 的入口各处都在，拿不到服务时页面自己说明未开启）。
 */
function isSectionAvailable(candidate: string | null): boolean {
  if (!candidate) return false;
  const known: ConfigWebAppSection[] = [
    'config',
    'autoCompact',
    'browserControl',
    'sessions',
    'roles',
    'mcp',
    'skills',
    'plugins',
  ];
  if (!known.includes(candidate as ConfigWebAppSection)) return false;
  if (candidate === 'autoCompact') return supportsAutoCompact();
  return true;
}

import { useEffect, useState } from 'react';
import { Sidebar } from './layout/Sidebar.js';
import { ConfigPage } from './pages/ConfigPage.js';
import { ConversationPage } from './pages/ConversationPage.js';
import { McpPage } from './pages/McpPage.js';
import { PluginsPage } from './pages/PluginsPage.js';
import { RolesPage } from './pages/RolesPage.js';
import { SessionsPage } from './pages/SessionsPage.js';
import { SkillsPage } from './pages/SkillsPage.js';
import { connectHeartbeat } from './api.js';
import type { ConfigWebSection } from '../../src/shared/types.js';

export function App() {
  const [section, setSection] = useState<ConfigWebSection>('config');
  const [dirtySection, setDirtySection] = useState<ConfigWebSection | null>(null);

  function changeSection(nextSection: ConfigWebSection) {
    if (
      dirtySection &&
      dirtySection !== nextSection &&
      !window.confirm('当前页面有未保存的修改，确定要离开吗？')
    ) {
      return;
    }
    setSection(nextSection);
  }

  function handleDirtyChange(current: ConfigWebSection, dirty: boolean) {
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
        {section === 'sessions' ? <SessionsPage /> : null}
        {section === 'conversation' ? <ConversationPage /> : null}
        {section === 'roles' ? <RolesPage onDirtyChange={(dirty) => handleDirtyChange('roles', dirty)} /> : null}
        {section === 'mcp' ? <McpPage onDirtyChange={(dirty) => handleDirtyChange('mcp', dirty)} /> : null}
        {section === 'skills' ? <SkillsPage onDirtyChange={(dirty) => handleDirtyChange('skills', dirty)} /> : null}
        {section === 'plugins' ? <PluginsPage /> : null}
      </div>
    </main>
  );
}

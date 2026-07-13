import { useEffect, useState } from 'react';
import { Sidebar } from './layout/Sidebar.js';
import { ConfigPage } from './pages/ConfigPage.js';
import { ConversationPage } from './pages/ConversationPage.js';
import { McpPage } from './pages/McpPage.js';
import { PluginsPage } from './pages/PluginsPage.js';
import { SkillsPage } from './pages/SkillsPage.js';
import { connectHeartbeat } from './api.js';
import type { ConfigWebSection } from '../../src/shared/types.js';

export function App() {
  const [section, setSection] = useState<ConfigWebSection>('config');
  const [conversationVersion, setConversationVersion] = useState(0);

  useEffect(() => {
    const socket = connectHeartbeat((event) => {
      if (event.type === 'conversation.updated') setConversationVersion((version) => version + 1);
    });
    return () => socket?.close();
  }, []);

  return (
    <main className="app-shell">
      <Sidebar section={section} onChange={setSection} />
      <div className="content-shell">
        {section === 'config' ? <ConfigPage /> : null}
        {section === 'conversation' ? <ConversationPage refreshSignal={conversationVersion} /> : null}
        {section === 'mcp' ? <McpPage /> : null}
        {section === 'skills' ? <SkillsPage /> : null}
        {section === 'plugins' ? <PluginsPage /> : null}
      </div>
    </main>
  );
}

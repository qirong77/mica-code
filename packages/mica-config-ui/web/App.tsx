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

export type ConfigWebAppProps = {
  /**
   * 打开时落到的页面。桌面端把配置页当整页打开，由入口决定（设置 → config，插件菜单 →
   * plugins）。缺省读地址栏的 `section`，浏览器宿主因此仍能深链。
   */
  initialSection?: ConfigWebAppSection;
  /** 打开时直接落到某个插件的详情（桌面端的插件菜单用）。 */
  initialPluginId?: string | null;
  /** 回到应用：由宿主提供时导航栏顶部出现「返回应用」，浏览器宿主不传。 */
  onClose?(): void;
  closeLabel?: string;
  /**
   * 在对话里打开某个插件的面板。只有桌面端提供：面板数据活在会话的 app-server 里，
   * 浏览器宿主（apps/config-web）没有会话可开。
   */
  onOpenPluginPanel?(pluginId: string): void;
};

export function App({
  initialSection,
  initialPluginId = null,
  onClose,
  closeLabel,
  onOpenPluginPanel,
}: ConfigWebAppProps = {}) {
  const [section, setSection] = useState<ConfigWebAppSection>(() => initialSection ?? readInitialSection());
  // 当前打开的插件详情：宿主（插件菜单）或地址栏（浏览器深链）指定，插件页只负责呈现。
  const [pluginId, setPluginId] = useState<string | null>(() => initialPluginId ?? readInitialPluginId());

  /**
   * 各页都是自动保存，切页面不用问「要不要放弃修改」；页面卸载时自己的 hook 会把最后
   * 一批改动发出去。
   */
  function changeSection(nextSection: ConfigWebAppSection) {
    setSection(nextSection);
    // 切走再回来不该又落在某个插件的详情上：那里是上一处的选择。
    setPluginId(null);
    writeUrl({ section: nextSection, plugin: null });
  }

  /** 插件页里选中 / 退出详情。地址栏同步，浏览器宿主刷新后仍停在同一处。 */
  function selectPlugin(nextPluginId: string | null) {
    setPluginId(nextPluginId);
    writeUrl({ section, plugin: nextPluginId });
  }

  useEffect(() => {
    const socket = connectHeartbeat();
    return () => socket?.close();
  }, []);

  return (
    <div className="mica-config-ui">
      <main className="app-shell">
        <Sidebar
          section={section}
          onChange={(next) => void changeSection(next)}
          onClose={onClose}
          closeLabel={closeLabel}
        />
        <div className="content-shell">
          {section === 'config' ? <ConfigPage /> : null}
          {section === 'browserControl' ? <BrowserControlPage /> : null}
          {section === 'terminalControl' ? <TerminalControlPage /> : null}
          {section === 'performance' ? <PerformancePage /> : null}
          {section === 'sessions' ? <SessionsPage /> : null}
          {section === 'roles' ? <RolesPage /> : null}
          {section === 'mcp' ? <McpPage /> : null}
          {section === 'skills' ? <SkillsPage /> : null}
          {section === 'capabilities' ? <CapabilitiesPage /> : null}
          {section === 'plugins' ? (
            <PluginsPage
              pluginId={pluginId}
              onSelectPlugin={selectPlugin}
              onOpenPluginPanel={onOpenPluginPanel}
            />
          ) : null}
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

/** 深链里的插件详情（`?section=plugins&plugin=memory`）：只认非空字符串，存在性由插件页判断。 */
function readInitialPluginId(): string | null {
  const candidate = new URLSearchParams(window.location.search).get('plugin');
  return candidate ? candidate : null;
}

/** 地址栏只留「在哪一页、哪个插件」两个参数，其余查询串原样保留。 */
function writeUrl({ section, plugin }: { section: ConfigWebAppSection; plugin: string | null }) {
  const url = new URL(window.location.href);
  url.searchParams.set('section', section);
  if (plugin) url.searchParams.set('plugin', plugin);
  else url.searchParams.delete('plugin');
  window.history.replaceState(null, '', url);
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

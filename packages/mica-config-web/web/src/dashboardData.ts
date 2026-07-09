import type { ConfigWebOverviewCard, ConfigWebSection } from '../../src/shared/types.js';

export const sectionLabels: Record<ConfigWebSection, string> = {
  config: 'Config',
  mcp: 'MCP',
  skills: 'Skills',
  plugins: 'Plugins',
};

export const sectionDescriptions: Record<ConfigWebSection, string> = {
  config: '集中编辑模型、Provider 与本地运行参数。',
  mcp: '查看 server 连接状态、工具数量与配置落点。',
  skills: '浏览已加载 skills，快速核对说明与参数提示。',
  plugins: '核查插件文件、加载状态与最近更新时间。',
};

export const sectionEyebrows: Record<ConfigWebSection, string> = {
  config: 'Workspace Settings',
  mcp: 'Runtime Connectivity',
  skills: 'Skill Library',
  plugins: 'Plugin Registry',
};

export const fallbackOverviewCards: ConfigWebOverviewCard[] = [
  {
    label: 'Config Surface',
    value: '4',
    trend: 'Sections',
    detail: '统一管理 config、MCP、skills 与 plugins。',
  },
  {
    label: 'Connected MCP',
    value: '0',
    trend: '0 servers',
    detail: '当前还没有成功连通的 MCP server。',
  },
  {
    label: 'Skill Library',
    value: '0',
    trend: 'Loaded',
    detail: '当前没有加载到 skills。',
  },
  {
    label: 'Plugin Health',
    value: 'OK',
    trend: '0 files',
    detail: '插件状态稳定，没有失败项。',
  },
];


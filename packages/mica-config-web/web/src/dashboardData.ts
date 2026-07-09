import type { ConfigWebSection } from '../../src/shared/types.js';

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

export const dashboardMetrics = [
  {
    label: 'Config Surface',
    value: '4',
    trend: 'Sections',
    detail: '配置、连接、技能与插件统一收拢到一个工作台。',
  },
  {
    label: 'Editor Mode',
    value: 'JSON',
    trend: 'Monaco',
    detail: '保留代码编辑效率，同时补足摘要、状态与导航层次。',
  },
  {
    label: 'Feedback Loop',
    value: 'Live',
    trend: 'Heartbeat',
    detail: '页面与本地 worker 保持心跳，让状态反馈更像真正的工具。',
  },
] as const;


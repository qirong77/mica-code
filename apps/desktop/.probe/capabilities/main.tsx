import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CapabilitiesPage } from '../../../../packages/mica-config-ui/web/pages/CapabilitiesPage';
import { ArcoSettings } from '../../../../packages/mica-config-ui/web/components/ArcoSettings';
import { Button, Segmented, Tag } from '../../../../packages/mica-config-ui/web/components/Ui';
import { setConfigWebClient, type ConfigWebClient } from '../../../../packages/mica-config-ui/web/api';
import { previewPrompt } from '../../../../packages/mica-config-ui/web/promptControlDraft';
import type { PromptControls, PromptSectionSnapshot } from '../../../../packages/mica-common/promptControls';
import type { ConfigWebCapabilitiesRuntime, ConfigWebCapabilityDefaults, ConfigWebCapabilityTool } from '../../../../packages/mica-config-ui/src/shared/types';
import '../../../../packages/mica-config-ui/web/styles.css';

const makeSelection = () => ({ version: 1 as const, disabledSkills: [], disabledTools: [], disabledMcpServers: [] });
let selection = makeSelection();
let defaults = makeSelection();
let controls: PromptControls = { version: 1, disabledPlugins: [], sections: {} };
const clone = <T,>(value: T): T => structuredClone(value);

const tool = (name: string, description: string, readOnly: boolean, pluginId?: string): ConfigWebCapabilityTool => ({
  name, description, readOnly, pluginId, parameters: [], source: 'builtin',
  group: pluginId ? { key: `plugin:${pluginId}`, label: pluginId === 'user.review' ? 'Review Helper' : pluginId } : null,
});
const tools: ConfigWebCapabilityTool[] = [
  { ...tool('read_file', '读取文件内容，返回带行号的文本。', true),
    parameters: [{ name: 'file_path', type: 'string', required: true, description: '要读取的文件路径' }, { name: 'offset', type: 'number', required: false, description: '起始行号' }],
    inputSchema: { type: 'object', properties: { file_path: { type: 'string', description: '文件路径' }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 2000 } }, required: ['file_path'] } },
  tool('run_shell', '执行 shell 命令，返回输出和退出码。', false),
  tool('apply_patch', '应用文件补丁，支持新增、更新和删除文件。', false),
  tool('todo_write', '更新当前回合的多阶段计划。', false, 'todo'),
  tool('memory', '读取或编辑持久记忆，支持用户、项目和领域范围。', false, 'memory'),
  tool('web_search', '搜索网络信息，返回标题、链接和摘要。', true, 'web-search'),
  tool('web_fetch', '抓取 URL 内容，将 HTML 转为可读正文。', true, 'web-search'),
  tool('review_diff', '检查代码差异，给出可以执行的审阅意见。', true, 'user.review'),
  tool('review_context', '读取本次变更涉及的调用点和依赖。', true, 'user.review'),
];
const skills = [
  { name: 'review', description: '评审代码变更，检查正确性和回归风险。', pluginId: 'user.review', path: '/example/plugins/review/SKILL.md' },
  { name: 'computer-use', description: '通过辅助功能树操作 Mac 上的应用。', pluginId: 'computer-use', path: '/example/skills/computer-use/SKILL.md' },
  { name: 'project-conventions', description: '这个项目的开发和测试约定。', path: '/example/.mica/skills/conventions/SKILL.md' },
];
const plugins: ConfigWebCapabilityDefaults['plugins'] = [
  { id: 'todo', name: 'Todo', description: '在多阶段工作中维护计划与进度。', source: 'official', state: 'enabled', loadStatus: 'loaded' },
  { id: 'memory', name: 'Memory', description: '为 Agent 提供可跨会话恢复的事实和偏好。', source: 'official', state: 'enabled', loadStatus: 'loaded' },
  { id: 'web-search', name: 'Web Search', description: '网络搜索与一手资料读取。', source: 'official', state: 'enabled', loadStatus: 'loaded' },
  { id: 'computer-use', name: 'Computer Use', description: 'Mac 桌面操作与界面读取。', source: 'official', state: 'enabled', loadStatus: 'loaded' },
  { id: 'user.review', name: 'Review Helper', description: '示例用户插件：包含工具、技能和可独立控制的提示词。', source: 'user', state: 'enabled', loadStatus: 'loaded' },
  { id: 'user.archive', name: 'Archive', description: '已停用的示例插件也会保留在目录中。', source: 'user', state: 'disabled' },
];

const section = (id: string, content: string, pluginId?: string, sectionId?: string): PromptSectionSnapshot => ({
  id, label: sectionId ?? id, originalContent: content, content, enabled: true, editable: id !== 'system', pluginId, sectionId,
});
const sections = [
  section('system', '# Mica\n\n你是运行在用户工作区的编程助手。理解用户目标，完成已经授权的工作。\n\n- 保留用户与其他协作者的改动。\n- 区分事实、推断和建议。\n- 按改动范围验证行为，诚实报告结果。'),
  section('role', '# 开发协作\n\n使用中文回答。先说明结果，再补充关键依据。优先采用项目已有的组件与抽象。'),
  section('project-instructions', '<document source="AGENT.md">\n# 项目约定\n\n- 使用共享 UI 控件与主题令牌。\n- 只修改与任务相关的文件。\n- 对行为改动运行针对性测试和类型检查。\n</document>'),
  section('skills', '可用 skills 索引如下。需要使用时读取完整说明。\n\n- review: 评审代码变更。\n- computer-use: 操作本机桌面。\n- project-conventions: 项目开发约定。'),
  section('context', '# 环境信息\n\n- 当前工作目录: /example/mica-code\n- 当前角色: developer\n- 操作系统: darwin\n- Shell: /bin/zsh'),
  section('plugin:todo/plan', '# 计划\n\n- 多阶段或跨文件的任务使用 todo_write 维护计划。\n- 条目按可验证的结果划分。\n- 开始时标为进行中，真正完成后再标为完成。', 'todo', 'plan'),
  section('plugin:memory/guidance', '# 会话记忆\n\n用户明确引用之前的工作、或本会话缺少上下文时，先读取相关历史，再核对当前事实。不要把历史推断当成已验证结论。', 'memory', 'guidance'),
  section('plugin:memory/facts', '# 已知事实\n\n- 用户使用中文沟通。\n- 当前项目的设置界面使用共享控件。\n\n这些是预览用的示例内容。', 'memory', 'facts'),
  section('plugin:web-search/guidance', '# 联网查证\n\n结论依赖可能变化的外部事实时，先搜索官方入口，再打开一手页面。准确结论需要完整资料，搜索摘要只作入口。', 'web-search', 'guidance'),
  section('plugin:user.review/guidance', '# 代码审阅\n\n请优先检查行为正确性、边界条件和可能造成的数据丢失。\n\n## 审阅输出\n\n- 给出可以复现或验证的具体问题。\n- 标明相关文件和影响范围。\n- 没有问题时直接说明，并指出尚未验证的部分。\n\n## 改动边界\n\n只针对当前 diff 提出意见，保留无关的工作区改动。', 'user.review', 'guidance'),
  section('plugin:user.review/session-context', '', 'user.review', 'session-context'),
];
const initialPrompt = previewPrompt(sections, controls);
const defaultDetails = (): ConfigWebCapabilityDefaults => ({ ...clone(defaults), tools: clone(tools), skills: clone(skills), plugins: clone(plugins), mcpServers: ['mica-browser', 'docs'] });

setConfigWebClient({
  readCapabilityDefaults: async () => defaultDetails(),
  writeCapabilityDefaults: async (next) => { defaults = { version: 1, ...clone(next) } as typeof defaults; return defaultDetails(); },
  readPromptControls: async () => clone(controls),
  writePromptControls: async (next) => { controls = clone(next); return clone(controls); },
} as ConfigWebClient);

const runtime: ConfigWebCapabilitiesRuntime = {
  key: 'capabilities-preview',
  read: async () => ({
    ok: true, selection: clone(selection), tools: clone(tools), skills: clone(skills),
    mcpServers: [{ name: 'mica-browser', status: 'connected' }, { name: 'docs', status: 'configured' }],
    mcpTools: [{ ...tool('mcp_browser_control', '受控浏览器：读取页面、点击、输入和截图。', false), source: 'mcp', group: { key: 'mcp:mica-browser', label: 'mica-browser' }, inputSchema: { type: 'object', properties: { action: { type: 'string' }, params: { type: 'object' } } } }],
    prompt: { cwd: '/example/mica-code', role: 'developer', running: false, preview: previewPrompt(sections, controls), lastSent: initialPrompt, sections: clone(sections) },
    plugins: plugins.filter((plugin) => plugin.state !== 'disabled').map((plugin) => ({
      id: plugin.id, name: plugin.name, status: 'loaded',
      toolNames: tools.filter((entry) => entry.pluginId === plugin.id).map((entry) => entry.name),
      skillNames: skills.filter((entry) => entry.pluginId === plugin.id).map((entry) => entry.name),
      promptSectionIds: sections.filter((entry) => entry.pluginId === plugin.id).map((entry) => entry.id),
    })),
  }),
  setSelection: async (next) => { selection = clone(next) as typeof selection; return { ok: true, selection: clone(selection) }; },
};

function Preview() {
  const [theme, setTheme] = useState('darcula');
  return (
    <div className="mica-config-ui preview-root">
      <div className="preview-header">
        <div><Tag tone="blue">交互预览</Tag><span>示例插件与提示词 · 修改仅保存在此页面</span></div>
        <div>
          <Segmented value={theme} options={[{ value: 'darcula', label: '深色' }, { value: 'light', label: '浅色' }]} ariaLabel="预览主题" size="compact" onChange={(next) => { setTheme(next); document.documentElement.dataset.theme = next; document.documentElement.dataset.appearance = next === 'light' ? 'light' : 'dark'; }} />
          <Button size="compact" variant="ghost" onClick={() => location.reload()}>重置示例</Button>
        </div>
      </div>
      <ArcoSettings>
        <div className="preview-main"><CapabilitiesPage runtime={runtime} /></div>
      </ArcoSettings>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Preview />);

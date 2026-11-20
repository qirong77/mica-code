import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PromptSectionSnapshot, RuntimePromptInspection } from '@packages/mica-common/promptControls.js';
import { PromptControlsPanel } from './PromptControlsPanel.js';

function render(sections: PromptSectionSnapshot[], pluginNames: Record<string, string> = {}) {
  const inspection: RuntimePromptInspection = {
    cwd: '/example',
    role: 'default',
    running: false,
    preview: '',
    lastSent: null,
    sections,
  };
  return renderToStaticMarkup(
    <PromptControlsPanel
      inspection={inspection}
      controls={{ version: 1, disabledPlugins: [], sections: {} }}
      focusId=""
      onFocus={() => {}}
      onChange={() => {}}
      pluginNames={pluginNames}
    />,
  );
}

function section(pluginId: string, label: string, pluginName?: string): PromptSectionSnapshot {
  return {
    id: `plugin:${pluginId}/context`,
    sectionId: 'context',
    pluginId,
    pluginName,
    label,
    originalContent: '',
    content: '',
    enabled: true,
    editable: true,
  };
}

describe('提示词来源展示', () => {
  it('directly names built-in capabilities and takes plugin names from the live registration', () => {
    const html = render(
      [
        section('builtin.session-autonomy', '并发会话', 'Built-in Session Autonomy'),
        section('memory', '历史会话', 'Memory'),
        section('user.notes', '项目笔记', 'Project Notes'),
      ],
      { memory: '过时的名称' },
    );
    expect(html).toContain('并发会话');
    expect(html).not.toContain('builtin.session-autonomy');
    expect(html).not.toContain('Built-in Session Autonomy');
    expect(html).toContain('ui-tag');
    expect(html).toContain('>Memory</span>');
    expect(html).toContain('>Project Notes</span>');
    expect(html).not.toContain('过时的名称');
  });

  it('uses catalog names when needed and avoids repeating a source identical to the title', () => {
    const html = render([section('user.notes', 'Notes'), section('user.policy', '使用策略')], {
      'user.notes': 'Notes',
      'user.policy': 'Team Policy',
    });
    expect(html).toContain('class="prompt-control-title">Notes</span>');
    expect(html).not.toContain('arco-tag-content">Notes</span>');
    expect(html).toContain('arco-tag-content">Team Policy</span>');
  });
});

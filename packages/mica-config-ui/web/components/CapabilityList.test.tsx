import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CapabilityList } from './CapabilityList.js';

describe('CapabilityList', () => {
  it('renders single-item groups as normal rows while preserving multi-item groups', () => {
    const html = renderToStaticMarkup(
      <CapabilityList
        groups={[{ key: 'tools', label: 'Tools' }]}
        group="tools"
        onGroupChange={vi.fn()}
        counts={{ tools: '2/4' }}
        items={[
          { name: 'agent', description: 'Agent description', group: { key: 'subagent', label: 'subagent' } },
          { name: 'read', description: 'Read description', group: { key: 'tasks', label: 'Tasks' } },
          { name: 'write', description: 'Write description', group: { key: 'tasks', label: 'Tasks' } },
          { name: 'standalone', description: 'Standalone description' },
        ]}
        countLabel="2 / 4"
        isEnabled={(name) => name === 'agent' || name === 'read'}
        onToggle={vi.fn()}
        onToggleGroup={vi.fn()}
      />,
    );

    expect(html).toContain('id="capability-tools-agent"');
    expect(html).toContain('Agent description');
    expect(html).not.toContain('capability-group-tools-subagent');
    expect(html).toContain('id="capability-tools-standalone"');
    expect(html).toContain('id="capability-group-tools-tasks"');
    expect(html).toContain('1/2');
    expect(html).not.toContain('id="capability-tools-read"');
    expect(html).not.toContain('id="capability-tools-write"');
  });
});

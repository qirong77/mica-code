import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { subagentRename } from './data/subagent-rename.js';
import { renamePluginId, renameSectionId, renameToolName } from './pluginRenames.js';
import { subagentPluginRename } from './migrations.js';

const dirs: string[] = [];

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mica-subagent-rename-'));
  dirs.push(dir);
  return dir;
}

function write(path: string, content: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf-8');
}

function read(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('pluginRenames', () => {
  it('maps both names in one step so sidecar never lands on subagent-legacy', () => {
    expect(renamePluginId('sidecar')).toBe('subagent');
    expect(renamePluginId('subagent')).toBe('subagent-legacy');
    expect(renamePluginId('btw')).toBe('btw');
    expect(renameSectionId('plugin:sidecar/events')).toBe('plugin:subagent/events');
    expect(renameSectionId('plugin:subagent/delegation')).toBe('plugin:subagent-legacy/delegation');
    expect(renameSectionId('skills')).toBe('skills');
    // 工具面同时从 11 个收到 6 个：同名的动作落进同一个工具，参数表达力度。
    expect(renameToolName('sidecar_spawn')).toBe('subagent_open');
    expect(renameToolName('sidecar_attach')).toBe('subagent_open');
    expect(renameToolName('sidecar_turns')).toBe('subagent_read');
    expect(renameToolName('sidecar_transcript')).toBe('subagent_read');
    expect(renameToolName('sidecar_abort')).toBe('subagent_stop');
    expect(renameToolName('sidecar_close')).toBe('subagent_stop');
    expect(renameToolName('agent')).toBe('agent');
  });
});

describe('会话迁移 subagent-plugin-rename', () => {
  function document() {
    return {
      snapshot: {
        subagentUsageHistory: [
          { pluginId: 'sidecar', origin: 'plugin' },
          { pluginId: 'subagent', origin: 'delegation' },
          { pluginId: 'subagent', origin: 'plugin' },
          { pluginId: 'btw' },
        ],
        capabilitySelection: {
          version: 1,
          disabledTools: ['sidecar_spawn', 'sidecar_turns', 'session-control', 'bash'],
          disabledSkills: ['sidecar', 'note'],
        },
      },
    };
  }

  it('moves usage attribution and capability choices to the new names', () => {
    const doc = document();
    expect(subagentPluginRename.apply(doc)).toBeGreaterThan(0);

    expect(doc.snapshot.subagentUsageHistory.map((record) => record.pluginId)).toEqual([
      'subagent',
      'subagent-legacy',
      // 改名后插件自己写的记录不能被当成旧的委派记录。
      'subagent',
      'btw',
    ]);
    // 两个旧名落进同一个新工具后要去重：停用 `subagent_open` 一条就够。
    expect(doc.snapshot.capabilitySelection.disabledTools).toEqual(['subagent_open', 'subagent_read', 'bash']);
    expect(doc.snapshot.capabilitySelection.disabledSkills).toEqual(['subagent', 'note']);
  });

  it('is idempotent:会话文件每轮都会变，迁移会跟着重跑', () => {
    const doc = document();
    subagentPluginRename.apply(doc);
    expect(subagentPluginRename.apply(doc)).toBe(0);
  });

  it('leaves documents without the old names alone', () => {
    const doc = { snapshot: { subagentUsageHistory: [{ pluginId: 'btw' }] } };
    expect(subagentPluginRename.apply(doc)).toBe(0);
    expect(doc).toEqual({ snapshot: { subagentUsageHistory: [{ pluginId: 'btw' }] } });
  });
});

describe('数据迁移 subagent-rename', () => {
  it('moves settings, switches, prompt controls, defaults and skill data to the new ids', () => {
    const root = home();
    write(join(root, 'plugin-settings', 'subagent.json'), { delegationMode: 'on-request' });
    write(join(root, 'plugin-settings', 'sidecar.json'), { stallMinutes: '9' });
    write(join(root, 'plugins-state.json'), { disabled: ['sidecar'] });
    write(join(root, 'prompt-controls.json'), {
      version: 1,
      disabledPlugins: ['subagent'],
      sections: {
        'plugin:subagent/delegation': { enabled: false },
        'plugin:sidecar/events': { content: '自定义' },
      },
      order: ['plugin:sidecar/events', 'plugin:subagent/delegation'],
    });
    write(join(root, 'config.json'), {
      capabilityDefaults: {
        disabledTools: ['sidecar_spawn', 'sidecar_status', 'sidecar_collect', 'session-control', 'bash'],
        disabledSkills: ['sidecar'],
      },
    });
    write(join(root, 'sidecar', 'SKILL.md'), '# skill');
    write(join(root, 'plugin-skills', 'sidecar.json'), { version: 2, pluginId: 'sidecar', skills: [] });

    expect(subagentRename.run({ home: root, log: () => {} })).toBeGreaterThan(0);

    // 旧 subagent 的设置先让位，sidecar 的设置才落到 subagent.json。
    expect(read(join(root, 'plugin-settings', 'subagent-legacy.json'))).toEqual({ delegationMode: 'on-request' });
    expect(read(join(root, 'plugin-settings', 'subagent.json'))).toEqual({ stallMinutes: '9' });
    expect(existsSync(join(root, 'plugin-settings', 'sidecar.json'))).toBe(false);

    expect(read(join(root, 'plugins-state.json')).disabled).toEqual(['subagent']);

    const controls = read(join(root, 'prompt-controls.json'));
    expect(Object.keys(controls.sections).sort()).toEqual([
      'plugin:subagent-legacy/delegation',
      'plugin:subagent/events',
    ]);
    expect(controls.disabledPlugins).toEqual(['subagent-legacy']);
    expect(controls.order).toEqual(['plugin:subagent/events', 'plugin:subagent-legacy/delegation']);

    const config = read(join(root, 'config.json'));
    expect(config.capabilityDefaults.disabledTools).toEqual(['subagent_open', 'subagent_status', 'bash']);
    expect(config.capabilityDefaults.disabledSkills).toEqual(['subagent']);

    expect(existsSync(join(root, 'sidecar'))).toBe(false);
    expect(readFileSync(join(root, 'subagent', 'SKILL.md'), 'utf-8')).toBe('# skill');
    expect(existsSync(join(root, 'plugin-skills', 'sidecar.json'))).toBe(false);
    expect(readdirSync(join(root, 'plugin-data', 'evolution', 'legacy-subagent-skill'))).not.toHaveLength(0);
    expect(existsSync(join(root, 'plugin-data', 'evolution', 'subagent-rename.json'))).toBe(true);
  });

  it('runs once: 再跑一遍不会把 subagent 继续改成 subagent-legacy', () => {
    const root = home();
    write(join(root, 'plugins-state.json'), { disabled: ['sidecar'] });
    expect(subagentRename.run({ home: root, log: () => {} })).toBeGreaterThan(0);
    expect(subagentRename.run({ home: root, log: () => {} })).toBe(0);
    expect(read(join(root, 'plugins-state.json')).disabled).toEqual(['subagent']);
  });

  it('archives instead of overwriting when the target settings file already exists', () => {
    const root = home();
    write(join(root, 'plugin-settings', 'subagent.json'), { delegationMode: 'on-request' });
    write(join(root, 'plugin-settings', 'subagent-legacy.json'), { delegationMode: 'proactive' });
    write(join(root, 'plugin-settings', 'sidecar.json'), { stallMinutes: '9' });

    subagentRename.run({ home: root, log: () => {} });

    // 目标那份不动，源文件原样归档；新插件仍然拿到 sidecar 的设置。
    expect(read(join(root, 'plugin-settings', 'subagent-legacy.json'))).toEqual({ delegationMode: 'proactive' });
    expect(read(join(root, 'plugin-settings', 'subagent.json'))).toEqual({ stallMinutes: '9' });
    expect(readdirSync(join(root, 'plugin-data', 'evolution', 'legacy-subagent-settings'))).not.toHaveLength(0);
  });

  it('writes nothing on a machine that never had either name', () => {
    const root = home();
    expect(subagentRename.run({ home: root, log: () => {} })).toBe(0);
    expect(existsSync(join(root, 'plugin-data', 'evolution', 'subagent-rename.json'))).toBe(true);
    expect(readdirSync(root)).toEqual(['plugin-data']);
  });
});

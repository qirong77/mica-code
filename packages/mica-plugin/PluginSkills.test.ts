import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLUGIN_SKILLS_DIR, publishPluginSkills, readPublishedPluginSkills } from './PluginSkills.js';
import { PLUGIN_STATE_FILE } from './PluginState.js';
import type { Skill } from '@packages/mica-skills/types.js';

let base: string;
let configDir: string;

function writeSkillFile(dir: string, name: string): Skill {
  const baseDir = join(dir, name);
  mkdirSync(baseDir, { recursive: true });
  writeFileSync(join(baseDir, 'SKILL.md'), `---\nname: ${name}\n---\n\nbody\n`, 'utf-8');
  return {
    name,
    description: `${name} desc`,
    content: 'body',
    baseDir,
  };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'mica-plugin-skills-'));
  configDir = join(base, 'home');
  mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
  if (base && existsSync(base)) rmSync(base, { recursive: true, force: true });
});

describe('plugin skill index', () => {
  it('publishes the SKILL.md path next to the metadata', () => {
    const skill = writeSkillFile(base, 'computer-use');

    const path = publishPluginSkills('computer-use', [skill], { configDir });
    expect(path).toBe(join(configDir, PLUGIN_SKILLS_DIR, 'computer-use.json'));

    const stored = JSON.parse(readFileSync(path!, 'utf-8'));
    expect(stored.pluginId).toBe('computer-use');
    expect(stored.skills[0].path).toBe(join(skill.baseDir, 'SKILL.md'));

    expect(readPublishedPluginSkills({ configDir })).toEqual([
      {
        pluginId: 'computer-use',
        name: 'computer-use',
        description: 'computer-use desc',
        path: join(skill.baseDir, 'SKILL.md'),
      },
    ]);
  });

  it('skips a skill whose SKILL.md was never materialized', () => {
    // 正文只在内存里（没落盘）的 skill 没法被补全插入，列出来只会误导
    publishPluginSkills(
      'memory-only',
      [{ name: 'ghost', description: '', content: '', baseDir: join(base, 'nowhere') } as Skill],
      { configDir },
    );

    expect(readPublishedPluginSkills({ configDir })).toEqual([]);
    expect(existsSync(join(configDir, PLUGIN_SKILLS_DIR, 'memory-only.json'))).toBe(false);
  });

  it('drops everything for a disabled plugin and for a deleted skill file', () => {
    const kept = writeSkillFile(base, 'keep');
    const dropped = writeSkillFile(base, 'dropped');
    const disabled = writeSkillFile(base, 'disabled');
    publishPluginSkills('plugin-a', [kept], { configDir });
    publishPluginSkills('plugin-b', [dropped], { configDir });
    publishPluginSkills('plugin-c', [disabled], { configDir });

    writeFileSync(join(configDir, PLUGIN_STATE_FILE), `${JSON.stringify({ disabled: ['plugin-c'] })}\n`, 'utf-8');
    rmSync(join(dropped.baseDir, 'SKILL.md'));

    expect(readPublishedPluginSkills({ configDir }).map((skill) => skill.name)).toEqual(['keep']);
  });

  it('keeps one entry per name and drops the index when nothing is left', () => {
    const first = writeSkillFile(base, 'duplicate');
    const second = writeSkillFile(base, 'duplicate');
    publishPluginSkills('plugin-a', [first, second], { configDir });
    expect(readPublishedPluginSkills({ configDir })).toHaveLength(1);

    publishPluginSkills('plugin-a', [], { configDir });
    expect(readPublishedPluginSkills({ configDir })).toEqual([]);
    expect(existsSync(join(configDir, PLUGIN_SKILLS_DIR, 'plugin-a.json'))).toBe(false);
  });

  it('sanitizes the plugin id into a plain file name', () => {
    const skill = writeSkillFile(base, 'nested');
    const path = publishPluginSkills('../evil/plugin', [skill], { configDir });

    expect(path).toBe(join(configDir, PLUGIN_SKILLS_DIR, '_evil_plugin.json'));
    expect(readPublishedPluginSkills({ configDir })).toHaveLength(1);
  });
});

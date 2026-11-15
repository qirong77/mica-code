import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { promptContributions } from './prompt-contributions.js';
import { normalizePromptControls } from '@packages/mica-config/promptControls.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function createHome() {
  const home = mkdtempSync(join(tmpdir(), 'mica-prompt-contributions-'));
  homes.push(home);
  mkdirSync(join(home, 'plugin-skills'), { recursive: true });
  return home;
}

const oldHistory = 'plugin:builtin.command-memory/guidance';
const history = 'plugin:memory/history';
const todo = 'plugin:todo/plan';
const autonomy = 'plugin:builtin.session-autonomy/guidance';

describe('提示词贡献归属迁移', () => {
  it('接近 1 MiB 的合法配置迁移后仍可读取，正文完整保留', () => {
    const home = createHome();
    const path = join(home, 'prompt-controls.json');
    const sections: Record<string, { content: string }> = { [oldHistory]: { content: 'keep history instructions' } };
    for (let index = 0; index < 6; index += 1) sections[`plugin:user.notes/large-${index}`] = { content: '' };
    const controls = { version: 1, disabledPlugins: [], sections };
    let remaining = 1024 * 1024 - 32 - Buffer.byteLength(JSON.stringify(controls), 'utf8');
    for (let index = 0; index < 6; index += 1) {
      const count = Math.min(200_000, remaining);
      sections[`plugin:user.notes/large-${index}`].content = 'x'.repeat(count);
      remaining -= count;
    }
    expect(() => normalizePromptControls(controls)).not.toThrow();
    writeFileSync(path, JSON.stringify(controls));
    expect(promptContributions.run({ home, log: () => {} })).toBe(1);
    const migrated = readFileSync(path, 'utf8');
    expect(Buffer.byteLength(migrated, 'utf8')).toBeLessThanOrEqual(1024 * 1024);
    const parsed = normalizePromptControls(JSON.parse(migrated));
    expect(parsed.sections[history]).toEqual(sections[oldHistory]);
    expect(parsed.sections['plugin:user.notes/large-0']).toEqual(sections['plugin:user.notes/large-0']);
  });

  it('保留历史回查的正文、停用与顺序，撤下段落原文先归档，重复执行为零', () => {
    const home = createHome();
    const path = join(home, 'prompt-controls.json');
    const original = JSON.stringify({
      version: 1,
      disabledPlugins: ['builtin.command-memory', 'user.notes'],
      sections: {
        [oldHistory]: { content: '我的历史回查约定' },
        [todo]: { content: '旧计划约定' },
        [autonomy]: { enabled: false },
        'plugin:video/video': { content: '旧视频说明' },
        'plugin:web-search/web-search': { enabled: false },
        context: { enabled: false },
      },
      order: [oldHistory, todo, autonomy, 'plugin:video/video', 'plugin:web-search/web-search', 'context'],
    });
    writeFileSync(path, original);
    expect(promptContributions.run({ home, log: () => {} })).toBe(1);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      disabledPlugins: ['user.notes'],
      sections: { [history]: { content: '我的历史回查约定', enabled: false }, context: { enabled: false } },
      order: [history, 'context'],
    });
    const archive = join(home, 'plugin-data', 'evolution', 'legacy-prompt-controls');
    expect(readFileSync(join(archive, readdirSync(archive)[0]), 'utf8')).toBe(original);
    expect(promptContributions.run({ home, log: () => {} })).toBe(0);
  });

  it('已有的新历史回查控制优先，不把 Memory 的其它段落一起关掉', () => {
    const home = createHome();
    const path = join(home, 'prompt-controls.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        disabledPlugins: ['builtin.command-memory'],
        sections: { [oldHistory]: { content: '旧正文' }, [history]: { content: '新正文', enabled: true } },
        order: [history, oldHistory],
      }),
    );
    expect(promptContributions.run({ home, log: () => {} })).toBe(1);
    const controls = JSON.parse(readFileSync(path, 'utf8'));
    expect(controls.sections[history]).toEqual({ content: '新正文', enabled: true });
    expect(controls.disabledPlugins).toEqual([]);
    expect(controls.order).toEqual([history]);
  });

  it('归档 Schedule 随包索引，保留用户 skill、同名 skill 的停用选择与排期数据', () => {
    const home = createHome();
    const index = join(home, 'plugin-skills', 'schedule.json');
    const legacy = {
      version: 2,
      pluginId: 'schedule',
      skills: [{ name: 'schedule', path: '/generated/SKILL.md', roles: [] }],
    };
    writeFileSync(index, JSON.stringify(legacy));
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ capabilityDefaults: { disabledTools: ['schedule'], disabledSkills: ['schedule', 'custom'] } }),
    );
    mkdirSync(join(home, 'skills', 'schedule'), { recursive: true });
    writeFileSync(join(home, 'skills', 'schedule', 'SKILL.md'), '用户内容');
    mkdirSync(join(home, 'plugin-data', 'schedule'), { recursive: true });
    writeFileSync(join(home, 'plugin-data', 'schedule', 'data.json'), '{"tasks":["保留"]}');
    expect(promptContributions.run({ home, log: () => {} })).toBe(1);
    expect(existsSync(index)).toBe(false);
    const archive = join(home, 'plugin-data', 'evolution', 'legacy-schedule-skill');
    expect(JSON.parse(readFileSync(join(archive, readdirSync(archive)[0]), 'utf8'))).toEqual(legacy);
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).capabilityDefaults).toEqual({
      disabledTools: ['schedule'],
      disabledSkills: ['schedule', 'custom'],
    });
    expect(readFileSync(join(home, 'skills', 'schedule', 'SKILL.md'), 'utf8')).toBe('用户内容');
    expect(readFileSync(join(home, 'plugin-data', 'schedule', 'data.json'), 'utf8')).toBe('{"tasks":["保留"]}');
    expect(promptContributions.run({ home, log: () => {} })).toBe(0);
  });

  it('未知索引和损坏控制不改写', () => {
    const home = createHome();
    const index = join(home, 'plugin-skills', 'schedule.json');
    const original = JSON.stringify({ version: 2, pluginId: 'other', skills: [] });
    writeFileSync(index, original);
    writeFileSync(join(home, 'prompt-controls.json'), '{bad');
    expect(promptContributions.run({ home, log: () => {} })).toBe(0);
    expect(readFileSync(index, 'utf8')).toBe(original);
    expect(readFileSync(join(home, 'prompt-controls.json'), 'utf8')).toBe('{bad');
  });
});

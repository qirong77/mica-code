import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PluginContext } from '@packages/mica-plugin/PluginContext.js';
import type { PluginSkillDefinition } from '@packages/mica-plugin/PluginDesktop.js';
import setup from './index.js';
import SKILL_MD from './skill/SKILL.md' with { type: 'text' };

/**
 * 部署中转机是 skill 的职责，不是插件的：插件只把 SKILL.md 注册进能力面，
 * 由 agent 现场取仓库、构建、部署。所以这里验证的是「注册这条路真的通」。
 */
type Captured = { skill: PluginSkillDefinition | null; health: Array<{ level: string; message: string }> };
type WithTasks = Captured & { tasks: string[] };

function fakeContext(dataDir: string, captured: Captured): PluginContext {
  return {
    paths: { home: '/tmp', config: dataDir, plugins: '/tmp' },
    settings: {
      get: () => ({ enabled: 'true', relayUrl: '', token: '' }),
      validate: () => [],
    },
    skills: {
      register(skill: PluginSkillDefinition) {
        captured.skill = skill;
        return { dispose: () => {}, skipped: [] };
      },
    },
    background: {
      register: (task: { id: string }) => {
        (captured as WithTasks).tasks?.push(task.id);
        return { dispose: () => {}, runNow: async () => {} };
      },
    },
    tools: { register: () => ({ dispose: () => {} }) },
    health: {
      report(entry: { level: string; message: string }) {
        captured.health.push(entry);
      },
    },
    logger: Object.assign(() => {}, {
      info: () => {},
      warn: () => {},
      error: () => {},
    }),
    onDispose: () => {},
  } as unknown as PluginContext;
}

describe('mobile-relay plugin setup', () => {
  let dataDir = '';

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'mica-mobile-relay-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('registers the deployment skill', () => {
    const captured: Captured = { skill: null, health: [] };
    setup(fakeContext(dataDir, captured));

    expect(captured.skill).not.toBeNull();
    expect(captured.skill?.name).toBe('mobile-relay-setup');
    // 只有描述进 system prompt 索引；正文按需加载，所以描述必须说清「什么时候用」
    expect(captured.skill?.description).toContain('手机');
  });

  it('writes SKILL.md into a directory it can actually read back', () => {
    const captured: Captured = { skill: null, health: [] };
    setup(fakeContext(dataDir, captured));

    const baseDir = captured.skill?.baseDir ?? '';
    expect(existsSync(join(baseDir, 'SKILL.md'))).toBe(true);
    // baseDir 与内容都要对得上：索引读目录、`skill` 工具读 content
    expect(readFileSync(join(baseDir, 'SKILL.md'), 'utf8')).toBe(captured.skill?.content);
  });

  it('keeps the GitHub address in the skill so the agent fetches scripts itself', () => {
    const captured: Captured = { skill: null, health: [] };
    setup(fakeContext(dataDir, captured));
    expect(captured.skill?.content).toContain('https://github.com/qirong77/mica-code');
  });

  it('parses the frontmatter fields the skill index needs', () => {
    const captured: Captured = { skill: null, health: [] };
    setup(fakeContext(dataDir, captured));

    // 解析不出 when_to_use，索引里就只剩一句描述，模型不知道什么时候该用它
    expect(captured.skill?.whenToUse).toBeTruthy();
    expect(captured.skill?.argumentHint).toBeTruthy();
  });

  it('ships a skill body that tells the agent not to read the packaged app', () => {
    // 这条是设计约束，不是文案偏好：从 app.asar 里抠产物会随版本漂移
    expect(SKILL_MD).toContain('app.asar');
    expect(SKILL_MD).toContain('electron-vite build');
  });

  // 页面更新只有配置页那个按钮：不在后台排期，也就不会替用户往外传 3MB。
  it('schedules only the bridge, never a page-sync task', () => {
    const captured: WithTasks = { skill: null, health: [], tasks: [] };
    setup(fakeContext(dataDir, captured));
    expect(captured.tasks).toEqual(['bridge']);
  });
});

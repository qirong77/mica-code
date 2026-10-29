import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MicaTool } from '@packages/mica-tools/index.js';
import type { PluginContext, PluginSkillDefinition } from '@packages/mica-plugin/index.js';
import setup, { RUNTIME_DIR_NAME, SKILL_NAME, materializeSkill, resolveRuntimeDir } from './index.js';

const tempDirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mica-sidecar-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(options: { session?: { id: string; cwd: string } | null } = {}) {
  const skills: PluginSkillDefinition[] = [];
  const tools: MicaTool[] = [];
  const health: { level: string; message: string; hint?: string }[] = [];
  const disposers: (() => void)[] = [];
  const home = tempHome();
  const ctx = {
    pluginId: 'sidecar',
    paths: { home, config: home, plugins: join(home, 'plugins') },
    skills: {
      register: (skill: PluginSkillDefinition) => {
        skills.push(skill);
        return { dispose() {}, skipped: [] };
      },
    },
    tools: {
      register: (tool: MicaTool) => {
        tools.push(tool);
        return { dispose() {} };
      },
    },
    session: {
      describe: vi.fn(() => options.session ?? null),
    },
    health: { report: (report: { level: string; message: string; hint?: string }) => health.push(report) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    onDispose: (disposer: () => void) => disposers.push(disposer),
  } as unknown as PluginContext;
  return { ctx, home, skills, tools, health, disposers };
}

describe('materializeSkill', () => {
  it('writes the body once and leaves an identical copy alone', () => {
    const dir = resolveRuntimeDir(tempHome());
    expect(materializeSkill(dir, 'body')).toBe('written');
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toBe('body');
    expect(materializeSkill(dir, 'body')).toBe('unchanged');
  });

  it('rewrites a file edited on disk', () => {
    const dir = resolveRuntimeDir(tempHome());
    materializeSkill(dir, 'body');
    writeFileSync(join(dir, 'SKILL.md'), 'edited', 'utf-8');
    expect(materializeSkill(dir, 'body')).toBe('written');
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toBe('body');
  });

  it('lands under $MICA_HOME/sidecar', () => {
    const home = tempHome();
    expect(resolveRuntimeDir(home)).toBe(join(home, RUNTIME_DIR_NAME));
  });
});

describe('setup', () => {
  it('registers the skill with a real on-disk path and the sidecar tools', () => {
    const { ctx, home, skills, tools, health } = harness({ session: { id: 'parent-1', cwd: '/tmp' } });
    setup(ctx);

    expect(skills).toHaveLength(1);
    const skill = skills[0]!;
    expect(skill.name).toBe(SKILL_NAME);
    expect(skill.baseDir).toBe(resolveRuntimeDir(home));
    // 补全插入的是这条绝对路径，文件不存在的话 skill 工具与 `/` 补全都会指向空气。
    expect(existsSync(join(skill.baseDir, 'SKILL.md'))).toBe(true);
    expect(skill.content.length).toBeGreaterThan(200);
    expect(skill.description).toContain('会话');

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'sidecar_abort',
      'sidecar_close',
      'sidecar_grep',
      'sidecar_send',
      'sidecar_spawn',
      'sidecar_status',
      'sidecar_transcript',
      'sidecar_turns',
      'sidecar_wait',
    ]);
    expect(health.at(-1)?.level).toBe('ok');
  });

  it('reads the parent session once at setup', () => {
    const { ctx } = harness({ session: { id: 'parent-42', cwd: '/tmp/work' } });
    setup(ctx);
    // 父会话 id 决定子会话落在侧栏哪一层，必须来自当前会话而不是进程 cwd 猜测。
    expect(ctx.session!.describe).toHaveBeenCalledTimes(1);
  });

  it('disposes every tool and every child process with the plugin', () => {
    const { ctx, disposers } = harness({ session: { id: 'parent-1', cwd: '/tmp' } });
    setup(ctx);
    expect(disposers).toHaveLength(1);
    expect(() => disposers[0]!()).not.toThrow();
  });
});

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext, PluginSkillDefinition } from '@packages/mica-plugin/index.js';
import setup, {
  RUNTIME_DIR_NAME,
  SKILL_NAME,
  materializeRuntime,
  renderSkillContent,
  resolveRuntimeDir,
} from './index.js';
import { COMPUTER_USE_RUNTIME_FILES } from './runtimeSources.js';

const RUNTIME_SOURCES: Record<string, string> = {
  'scripts/desktop.mjs': new URL('./runtime/scripts/desktop.mjs', import.meta.url).pathname,
  'src/helper.m': new URL('./runtime/src/helper.m', import.meta.url).pathname,
};

const tempDirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mica-computer-use-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('embedded runtime', () => {
  it('stays in sync with runtime/** (regenerate with scripts/generate-computer-use-sources.mjs)', () => {
    expect(Object.keys(COMPUTER_USE_RUNTIME_FILES).sort()).toEqual(Object.keys(RUNTIME_SOURCES).sort());
    for (const [target, source] of Object.entries(RUNTIME_SOURCES)) {
      expect(COMPUTER_USE_RUNTIME_FILES[target]).toBe(readFileSync(source, 'utf-8'));
    }
  });
});

describe('materializeRuntime', () => {
  it('writes the runtime once and leaves unchanged files alone', () => {
    const dir = resolveRuntimeDir(tempHome());
    const content = renderSkillContent(dir);

    const first = materializeRuntime(dir, content);
    expect(first.written.sort()).toEqual(['SKILL.md', 'scripts/desktop.mjs', 'src/helper.m']);
    expect(readFileSync(join(dir, 'src', 'helper.m'), 'utf-8')).toBe(COMPUTER_USE_RUNTIME_FILES['src/helper.m']);

    const compileMarker = join(dir, 'src', 'helper.m');
    const mtime = statSync(compileMarker).mtimeMs;
    const second = materializeRuntime(dir, content);
    // helper 的编译缓存按源码 mtime 判断：内容没变时不能重写，否则每次启动都要重新 clang 编译
    expect(second.written).toEqual([]);
    expect(second.unchanged).toHaveLength(3);
    expect(statSync(compileMarker).mtimeMs).toBe(mtime);
  });

  it('rewrites a file that was edited on disk', () => {
    const dir = resolveRuntimeDir(tempHome());
    const content = renderSkillContent(dir);
    materializeRuntime(dir, content);

    writeFileSync(join(dir, 'scripts', 'desktop.mjs'), 'broken', 'utf-8');
    const again = materializeRuntime(dir, content);
    expect(again.written).toEqual(['scripts/desktop.mjs']);
  });
});

function harness(pluginId = 'computer-use') {
  const skills: PluginSkillDefinition[] = [];
  const health: { level: string; message: string }[] = [];
  const ctx = {
    pluginId,
    paths: { home: tempHome(), config: '', plugins: '' },
    skills: {
      register: (skill: PluginSkillDefinition) => {
        skills.push(skill);
        return { dispose() {}, skipped: [] };
      },
    },
    health: { report: (report: { level: string; message: string }) => health.push(report) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    onDispose: vi.fn(),
  } as unknown as PluginContext;
  ctx.paths = { home: '/tmp', config: tempHome(), plugins: '/tmp/plugins' };
  return { ctx, skills, health };
}

describe('setup', () => {
  it.skipIf(process.platform !== 'darwin')('materializes the runtime and registers the skill with a real path', () => {
    const { ctx, skills, health } = harness();
    setup(ctx);

    const runtimeDir = resolveRuntimeDir(ctx.paths?.config);
    expect(runtimeDir.endsWith(RUNTIME_DIR_NAME)).toBe(true);
    expect(skills).toHaveLength(1);
    const skill = skills[0]!;
    expect(skill.name).toBe(SKILL_NAME);
    expect(skill.baseDir).toBe(runtimeDir);
    // 正文里的占位符必须被替换成真实路径，否则模型拿到的是不可执行的命令
    expect(skill.content).not.toContain('{{RUNTIME_DIR}}');
    expect(skill.content).toContain(runtimeDir);
    expect(skill.description).toContain('macOS');
    expect(health.at(-1)?.level).toBe('ok');
  });

  it('reports a warning instead of registering on other platforms', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    try {
      const { ctx, skills, health } = harness();
      setup(ctx);
      expect(skills).toEqual([]);
      expect(health.at(-1)?.level).toBe('warn');
      expect(health.at(-1)?.message).toContain('macOS');
    } finally {
      platform.mockRestore();
    }
  });
});

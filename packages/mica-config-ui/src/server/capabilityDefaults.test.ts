import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptControls } from '@packages/mica-common/promptControls.js';
import { micaConfig } from '@packages/mica-config/index.js';
import { micaMcp } from '@packages/mica-mcp/index.js';
import { micaSkills } from '@packages/mica-skills/index.js';
import { micaTools } from '@packages/mica-tools/index.js';
import type { Skill } from '@packages/mica-skills/types.js';
import { runConfigWebAction } from './actions.js';
import { getCapabilityDefaultsDetails } from './capabilityDefaults.js';

let previousHome: string | undefined;
let testHome: string;

beforeEach(() => {
  previousHome = process.env.MICA_HOME;
  testHome = mkdtempSync(join(tmpdir(), 'mica-capability-defaults-'));
  process.env.MICA_HOME = testHome;
  vi.spyOn(micaSkills, 'getLoaded').mockReturnValue([]);
  vi.spyOn(micaMcp, 'loadConfig').mockResolvedValue({});
  vi.spyOn(micaTools, 'getCatalog').mockReturnValue([]);
  vi.spyOn(micaConfig, 'readCapabilityDefaults').mockReturnValue({
    version: 1,
    disabledSkills: [],
    disabledTools: [],
    disabledMcpServers: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.MICA_HOME;
  else process.env.MICA_HOME = previousHome;
  rmSync(testHome, { recursive: true, force: true });
});

describe('default capability catalog', () => {
  it('lists manifest skills before a plugin has ever run, without importing its entry', async () => {
    const root = writePlugin('fresh', ['skills', 'single']);
    const grouped = writeSkill(join(root, 'skills', 'grouped'), 'grouped-skill', 'A grouped skill');
    const single = writeSkill(join(root, 'single'), 'single-skill', 'A direct skill');

    const details = await getCapabilityDefaultsDetails();

    expect(details.skills).toEqual([
      {
        name: grouped.name,
        description: grouped.description,
        pluginId: 'user.fresh',
        path: join(grouped.baseDir, 'SKILL.md'),
      },
      {
        name: single.name,
        description: single.description,
        pluginId: 'user.fresh',
        path: join(single.baseDir, 'SKILL.md'),
      },
    ]);
    expect(details.plugins.find((plugin) => plugin.id === 'user.fresh')).toMatchObject({
      name: 'fresh',
      state: 'enabled',
      source: 'user',
    });
    expect(details.plugins.find((plugin) => plugin.id === 'todo')).toMatchObject({ source: 'official' });
  });

  it('deduplicates disk, published and manifest skills with disk names taking priority', async () => {
    const root = writePlugin('dupes', ['skills', 'skills/declared']);
    const declared = writeSkill(join(root, 'skills', 'declared'), 'shared', 'Declared version');
    const published = writeSkill(join(root, 'skills', 'published'), 'published', 'File version');
    publishSkills('user.dupes', [declared, published], 'Published version');
    const disk = writeSkill(join(testHome, 'skills', 'shared'), 'shared', 'Disk override');
    vi.mocked(micaSkills.getLoaded).mockReturnValue([disk]);

    const details = await getCapabilityDefaultsDetails();

    expect(details.skills.map((skill) => skill.name)).toEqual(['published', 'shared']);
    expect(details.skills.find((skill) => skill.name === 'shared')).toMatchObject({
      description: 'Disk override',
      path: join(disk.baseDir, 'SKILL.md'),
    });
    expect(details.skills.find((skill) => skill.name === 'shared')?.pluginId).toBeUndefined();
    expect(details.skills.find((skill) => skill.name === 'published')).toMatchObject({
      description: 'Published version',
      pluginId: 'user.dupes',
      path: join(published.baseDir, 'SKILL.md'),
    });
  });

  it('attributes an already loaded official plugin skill from its published path', async () => {
    const skill = writeSkill(join(testHome, 'computer-use'), 'computer-use', 'Desktop control');
    publishSkills('computer-use', [skill]);
    vi.mocked(micaSkills.getLoaded).mockReturnValue([skill]);

    expect((await getCapabilityDefaultsDetails()).skills).toEqual([
      {
        name: skill.name,
        description: skill.description,
        path: join(skill.baseDir, 'SKILL.md'),
        pluginId: 'computer-use',
      },
    ]);
  });

  it('hides disabled plugin skills from both sources immediately and restores them when enabled', async () => {
    const root = writePlugin('toggle', ['skills']);
    const declared = writeSkill(join(root, 'skills', 'declared'), 'declared', 'Manifest skill');
    const published = writeSkill(join(root, 'dynamic'), 'published', 'Published skill');
    publishSkills('user.toggle', [published]);
    expect((await getCapabilityDefaultsDetails()).skills).toHaveLength(2);

    writeFileSync(join(testHome, 'plugins-state.json'), JSON.stringify({ disabled: ['user.toggle'] }));
    const disabled = await getCapabilityDefaultsDetails();
    expect(disabled.skills).toEqual([]);
    expect(disabled.plugins.find((plugin) => plugin.id === 'user.toggle')?.state).toBe('disabled');

    writeFileSync(join(testHome, 'plugins-state.json'), JSON.stringify({ disabled: [] }));
    expect((await getCapabilityDefaultsDetails()).skills.map((skill) => skill.name)).toEqual([
      declared.name,
      published.name,
    ]);
  });

  it('keeps broken plugins visible and ignores stale indexes and missing skill files', async () => {
    const root = writePlugin('broken', []);
    writeFileSync(join(root, 'plugin.json'), '{broken');
    const missing = writeSkill(join(testHome, 'gone'), 'missing', 'Will disappear');
    publishSkills('todo', [missing]);
    rmSync(join(missing.baseDir, 'SKILL.md'));
    const stale = writeSkill(join(testHome, 'uninstalled'), 'stale', 'Removed plugin');
    publishSkills('user.uninstalled', [stale]);

    const details = await getCapabilityDefaultsDetails();

    expect(details.skills).toEqual([]);
    expect(details.plugins.find((plugin) => plugin.id === 'user.broken')).toMatchObject({
      state: 'failed',
      source: 'user',
      error: expect.stringContaining('plugin.json'),
    });
  });

  it('preserves default selections and tool provenance while excluding MCP tools', async () => {
    const inputSchema = {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['read', 'write'] },
        entries: { type: 'array', items: { type: 'object' } },
      },
      required: ['mode'],
    };
    vi.mocked(micaConfig.readCapabilityDefaults).mockReturnValue({
      version: 1,
      disabledSkills: ['skill-a'],
      disabledTools: ['tool-a'],
      disabledMcpServers: ['server-a'],
    });
    vi.mocked(micaTools.getCatalog).mockReturnValue([
      {
        name: 'tool-a',
        description: 'Plugin tool',
        readOnly: false,
        parameters: [],
        source: 'builtin',
        group: { key: 'plugin:todo', label: 'Todo' },
        inputSchema,
      },
      { name: 'mcp-a', description: 'MCP tool', readOnly: true, parameters: [], source: 'mcp', group: null },
    ]);
    vi.mocked(micaMcp.loadConfig).mockResolvedValue({ 'server-a': { command: 'server' } });

    const details = await getCapabilityDefaultsDetails();

    expect(details).toMatchObject({
      disabledSkills: ['skill-a'],
      disabledTools: ['tool-a'],
      disabledMcpServers: ['server-a'],
      mcpServers: ['server-a'],
    });
    expect(details.tools).toEqual([
      {
        name: 'tool-a',
        description: 'Plugin tool',
        readOnly: false,
        parameters: [],
        source: 'builtin',
        group: { key: 'plugin:todo', label: 'Todo' },
        pluginId: 'todo',
        inputSchema,
      },
    ]);
  });
});

describe('prompt control config actions', () => {
  const controls: PromptControls = {
    version: 1,
    disabledPlugins: ['todo'],
    sections: {
      'plugin:todo/plan': { enabled: false, content: 'Custom policy\nSecond line' },
      skills: { enabled: true },
    },
  };

  it('round-trips plugin switches and section edits through the shared action table', async () => {
    expect(await runConfigWebAction('readPromptControls')).toEqual({ version: 1, disabledPlugins: [], sections: {} });
    expect(await runConfigWebAction('writePromptControls', { controls })).toEqual(controls);
    expect(await runConfigWebAction('readPromptControls')).toEqual(controls);
    expect(JSON.parse(readFileSync(join(testHome, 'prompt-controls.json'), 'utf-8'))).toEqual(controls);
  });

  it('rejects incomplete or invalid payloads without erasing saved controls', async () => {
    await runConfigWebAction('writePromptControls', { controls });
    expect(() => runConfigWebAction('writePromptControls', {})).toThrow('controls must be object');
    expect(() => runConfigWebAction('writePromptControls', { controls: [] })).toThrow('controls must be object');
    expect(() =>
      runConfigWebAction('writePromptControls', {
        controls: { ...controls, sections: { 'plugin:todo/plan': { content: 42 } } },
      }),
    ).toThrow('content must be a string');
    expect(await runConfigWebAction('readPromptControls')).toEqual(controls);
  });
});

function writePlugin(id: string, skills: string[]): string {
  const root = join(testHome, 'plugins', id);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'plugin.json'),
    JSON.stringify({ id, name: id, version: '1.0.0', main: 'index.js', skills }),
  );
  // A catalog read must never import this module or call setup.
  writeFileSync(join(root, 'index.js'), 'throw new Error("A static catalog must not execute plugin code");');
  return root;
}

function writeSkill(baseDir: string, name: string, description: string): Skill {
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\nSkill body\n`;
  mkdirSync(baseDir, { recursive: true });
  writeFileSync(join(baseDir, 'SKILL.md'), content);
  return { name, description, content, baseDir };
}

function publishSkills(pluginId: string, skills: Skill[], description?: string): void {
  const root = join(testHome, 'plugin-skills');
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, `${pluginId}.json`),
    JSON.stringify({
      version: 2,
      pluginId,
      skills: skills.map((skill) => ({
        name: skill.name,
        description: description ?? skill.description,
        path: join(skill.baseDir, 'SKILL.md'),
        roles: [],
      })),
    }),
  );
}

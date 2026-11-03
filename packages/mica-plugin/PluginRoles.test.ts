import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadManifestRoles,
  publishPluginRoles,
  readPublishedPluginRoles,
  resolvePluginRolesDir,
} from './PluginRoles.js';
import { writePluginState } from './PluginState.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mica-plugin-roles-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeRole(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  writeFileSync(path, body, 'utf-8');
  return path;
}

describe('loadManifestRoles', () => {
  it('reads every markdown file in a declared directory', () => {
    const pluginRoot = join(root, 'plugin');
    writeRole(join(pluginRoot, 'roles'), '需求开发', '# A');
    writeRole(join(pluginRoot, 'roles'), '商诉排查', '# B');
    writeFileSync(join(pluginRoot, 'roles', 'notes.txt'), 'x', 'utf-8');

    const { roles, problems } = loadManifestRoles(pluginRoot, ['roles']);
    expect(problems).toEqual([]);
    expect(roles.map((role) => role.name)).toEqual(['商诉排查', '需求开发']);
  });

  it('accepts a single markdown file as the declaration', () => {
    const pluginRoot = join(root, 'plugin');
    const path = writeRole(join(pluginRoot, 'one'), '审查', '# C');
    const { roles } = loadManifestRoles(pluginRoot, ['one/审查.md']);
    expect(roles).toEqual([{ name: '审查', path }]);
  });

  it('reports missing paths instead of throwing', () => {
    const { roles, problems } = loadManifestRoles(join(root, 'plugin'), ['roles', 'nope']);
    expect(roles).toEqual([]);
    expect(problems.join()).toContain('roles：路径不存在');
  });
});

describe('publishPluginRoles', () => {
  it('writes an index the reader can consume', () => {
    const path = writeRole(join(root, 'plugin', 'roles'), '需求开发', '# A');
    publishPluginRoles('user.demand-dev', [{ name: '需求开发', path }], { configDir: root });

    const roles = readPublishedPluginRoles({ configDir: root });
    expect(roles).toEqual([{ pluginId: 'user.demand-dev', name: '需求开发', path }]);
    const index = JSON.parse(readFileSync(join(resolvePluginRolesDir({ configDir: root }), 'user.demand-dev.json'), 'utf-8'));
    expect(index.version).toBe(1);
  });

  it('drops the index when the plugin stops shipping roles', () => {
    const path = writeRole(join(root, 'plugin', 'roles'), '需求开发', '# A');
    publishPluginRoles('user.demand-dev', [{ name: '需求开发', path }], { configDir: root });
    publishPluginRoles('user.demand-dev', [], { configDir: root });
    expect(existsSync(join(resolvePluginRolesDir({ configDir: root }), 'user.demand-dev.json'))).toBe(false);
  });

  it('skips entries whose file disappeared', () => {
    const path = join(root, 'gone.md');
    publishPluginRoles('user.demand-dev', [{ name: '需求开发', path }], { configDir: root });
    expect(readPublishedPluginRoles({ configDir: root })).toEqual([]);
  });

  it('ignores disabled plugins', () => {
    const path = writeRole(join(root, 'plugin', 'roles'), '需求开发', '# A');
    publishPluginRoles('user.demand-dev', [{ name: '需求开发', path }], { configDir: root });
    writePluginState({ disabled: ['user.demand-dev'] }, { path: join(root, 'plugins-state.json') });
    expect(readPublishedPluginRoles({ configDir: root })).toEqual([]);
  });
});

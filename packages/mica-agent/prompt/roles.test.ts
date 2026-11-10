import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import DEFAULT_SYSTEM_PROMPT from './system.md' with { type: 'text' };
import { applyBrandTemplate } from './brandTemplate.js';
import { getAgentRole, getRolesDirectory, listAgentRoles } from './roles.js';

/** 插件装配时写下的那份索引（`$MICA_HOME/plugin-roles/<pluginId>.json`）。 */
function writePluginRole(home: string, pluginId: string, name: string, body: string): string {
  const source = join(home, 'plugin-source');
  mkdirSync(source, { recursive: true });
  const path = join(source, `${name}.md`);
  writeFileSync(path, body, 'utf-8');
  const indexDir = join(home, 'plugin-roles');
  mkdirSync(indexDir, { recursive: true });
  writeFileSync(
    join(indexDir, `${pluginId}.json`),
    JSON.stringify({ version: 1, pluginId, roles: [{ name, path }] }),
    'utf-8',
  );
  return path;
}

const previousMicaHome = process.env.MICA_HOME;
const tempHomes: string[] = [];

afterEach(() => {
  if (previousMicaHome === undefined) delete process.env.MICA_HOME;
  else process.env.MICA_HOME = previousMicaHome;
  for (const home of tempHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('agent roles', () => {
  it('always lists the built-in default without creating a role directory', () => {
    const home = createTempHome();

    expect(listAgentRoles()).toEqual([
      { name: 'default', prompt: applyBrandTemplate(DEFAULT_SYSTEM_PROMPT), builtIn: true },
    ]);
    expect(getRolesDirectory()).toBe(join(home, 'role'));
  });

  it('loads markdown file stems as role names and reserves default for Mica', () => {
    const home = createTempHome();
    const roleDir = join(home, 'role');
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(join(roleDir, 'reviewer.md'), 'Review every change.', 'utf-8');
    writeFileSync(join(roleDir, 'ignored.txt'), 'Ignore this file.', 'utf-8');
    writeFileSync(join(roleDir, 'default.md'), 'Do not override Mica.', 'utf-8');
    writeFileSync(join(roleDir, 'DEFAULT.md'), 'Do not alias Mica.', 'utf-8');
    writeFileSync(join(roleDir, 'default.md.md'), 'Do not duplicate Mica.', 'utf-8');
    mkdirSync(join(roleDir, 'ignored-directory'));

    const roles = listAgentRoles();

    expect(roles.map((role) => role.name)).toEqual(['default', 'reviewer']);
    expect(getAgentRole('default')?.prompt).toBe(applyBrandTemplate(DEFAULT_SYSTEM_PROMPT));
    expect(getAgentRole('reviewer')).toMatchObject({
      name: 'reviewer',
      prompt: 'Review every change.',
      builtIn: false,
      path: join(roleDir, 'reviewer.md'),
    });
  });

  it('lists plugin roles as appended prompt segments', () => {
    const home = createTempHome();
    const path = writePluginRole(home, 'user.demand-dev', '需求开发', '只改 B 端。');

    expect(listAgentRoles().map((role) => role.name)).toEqual(['default', '需求开发']);
    expect(getAgentRole('需求开发')).toMatchObject({
      name: '需求开发',
      prompt: '只改 B 端。',
      builtIn: false,
      pluginId: 'user.demand-dev',
      path,
    });
  });

  it('lets a disk role shadow a plugin role of the same name', () => {
    const home = createTempHome();
    writePluginRole(home, 'user.demand-dev', '需求开发', '插件版');
    const roleDir = join(home, 'role');
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(join(roleDir, '需求开发.md'), '磁盘版', 'utf-8');

    const role = getAgentRole('需求开发');
    expect(role?.prompt).toBe('磁盘版');
  });

  it('skips plugin index entries whose file is gone', () => {
    const home = createTempHome();
    writePluginRole(home, 'user.demand-dev', '需求开发', 'x');
    rmSync(join(home, 'plugin-source'), { recursive: true, force: true });
    expect(listAgentRoles().map((role) => role.name)).toEqual(['default']);
  });
});

function createTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'mica-roles-'));
  tempHomes.push(home);
  process.env.MICA_HOME = home;
  return home;
}

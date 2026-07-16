import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import DEFAULT_SYSTEM_PROMPT from './system.md' with { type: 'text' };
import { getAgentRole, getRolesDirectory, listAgentRoles } from './roles.js';

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

    expect(listAgentRoles()).toEqual([{ name: 'default', prompt: DEFAULT_SYSTEM_PROMPT, builtIn: true }]);
    expect(getRolesDirectory()).toBe(join(home, 'role'));
  });

  it('loads markdown file stems as role names and reserves default for Mica', () => {
    const home = createTempHome();
    const roleDir = join(home, 'role');
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(join(roleDir, 'reviewer.md'), 'Review every change.', 'utf-8');
    writeFileSync(join(roleDir, 'ignored.txt'), 'Ignore this file.', 'utf-8');
    writeFileSync(join(roleDir, 'default.md'), 'Do not override Mica.', 'utf-8');
    mkdirSync(join(roleDir, 'ignored-directory'));

    const roles = listAgentRoles();

    expect(roles.map((role) => role.name)).toEqual(['default', 'reviewer']);
    expect(getAgentRole('default')?.prompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(getAgentRole('reviewer')).toMatchObject({
      name: 'reviewer',
      prompt: 'Review every change.',
      builtIn: false,
      path: join(roleDir, 'reviewer.md'),
    });
    expect(getAgentRole('reviewer.md')?.name).toBe('reviewer');
  });
});

function createTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'mica-roles-'));
  tempHomes.push(home);
  process.env.MICA_HOME = home;
  return home;
}

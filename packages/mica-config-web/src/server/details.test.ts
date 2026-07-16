import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRole, getRolesDetails, writeRole } from './details.js';

let home = '';
let previousMicaHome: string | undefined;

beforeEach(() => {
  previousMicaHome = process.env.MICA_HOME;
  home = mkdtempSync(join(tmpdir(), 'mica-config-web-role-'));
  process.env.MICA_HOME = home;
});

afterEach(() => {
  if (previousMicaHome === undefined) delete process.env.MICA_HOME;
  else process.env.MICA_HOME = previousMicaHome;
  rmSync(home, { recursive: true, force: true });
});

describe('config web roles', () => {
  it('creates markdown role files while exposing names without the extension', () => {
    const details = createRole('reviewer', 'Review carefully.');

    expect(details.roles.map((role) => role.name)).toEqual(['default', 'reviewer']);
    expect(readFileSync(join(home, 'role', 'reviewer.md'), 'utf-8')).toBe('Review carefully.');
  });

  it('updates custom roles and keeps the built-in role read-only', () => {
    createRole('reviewer');
    const details = writeRole('reviewer', 'Updated prompt.');

    expect(details.roles.find((role) => role.name === 'reviewer')?.content).toBe('Updated prompt.');
    expect(() => writeRole('default', 'Override')).toThrow('Editable role not found');
  });

  it('rejects duplicate and unsafe role names', () => {
    createRole('reviewer.md');

    expect(() => createRole('reviewer')).toThrow();
    expect(() => createRole('../escape')).toThrow('Role name may only contain');
    expect(getRolesDetails().roles).toHaveLength(2);
  });
});

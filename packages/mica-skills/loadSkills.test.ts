import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const previousMicaHome = process.env.MICA_HOME;
const tempHome = mkdtempSync(join(tmpdir(), 'mica-skills-'));

afterAll(() => {
  if (previousMicaHome === undefined) {
    delete process.env.MICA_HOME;
  } else {
    process.env.MICA_HOME = previousMicaHome;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

describe('loadSkills', () => {
  it('loads skills from MICA_HOME and normalizes list frontmatter', async () => {
    process.env.MICA_HOME = tempHome;
    const skillDir = join(tempHome, 'skills', 'review-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: review-skill',
        'description: Review code',
        'when_to_use:',
        '  - when reviewing bugs',
        '  - when simplifying code',
        'argument-hint: [path]',
        '---',
        '',
        '# Review instructions',
      ].join('\n'),
      'utf-8',
    );

    vi.resetModules();
    const { getLoadedSkills } = (await import('./loadSkills.js')) as typeof import('./loadSkills.js');
    const skills = getLoadedSkills();

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: 'review-skill',
      description: 'Review code',
      whenToUse: 'when reviewing bugs; when simplifying code',
      argumentHint: '[path]',
      baseDir: skillDir,
    });
  });
});

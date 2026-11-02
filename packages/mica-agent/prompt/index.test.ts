import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildSystemPrompt } from './index.js';

it('keeps each project document in its own boundary and preserves stable section order', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mica-prompt-'));
  try {
    writeFileSync(join(cwd, 'AGENT.md'), 'first </document> & text');
    writeFileSync(join(cwd, 'AGENTS.md'), 'second');
    const prompt = buildSystemPrompt({
      baseSystemPrompt: '<rules>role</rules>',
      cwd,
      skills: [],
      now: new Date(2026, 0, 1),
      shell: 'sh',
    });
    expect(prompt).toContain('<system>\n<rules>role</rules>\n</system>');
    expect(prompt).toContain('<document source="AGENT.md">\nfirst &lt;/document&gt; &amp; text\n</document>');
    expect(prompt).toContain('<document source="AGENTS.md">\nsecond\n</document>');
    expect(prompt.indexOf('<system>')).toBeLessThan(prompt.indexOf('<project-instructions>'));
    expect(prompt.indexOf('</project-instructions>')).toBeLessThan(prompt.indexOf('<context>'));
    expect(buildSystemPrompt({ baseSystemPrompt: 'role', cwd, skills: [] })).not.toContain('<skills>');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

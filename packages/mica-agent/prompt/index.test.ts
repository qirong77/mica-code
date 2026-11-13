import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildSystemPrompt } from './index.js';
import DEFAULT_SYSTEM_PROMPT from './system.md' with { type: 'text' };
import { applyBrandTemplate } from './brandTemplate.js';

const defaultSection = `<system>\n${applyBrandTemplate(DEFAULT_SYSTEM_PROMPT).trim()}\n</system>`;

it('keeps each project document in its own boundary and preserves stable section order', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mica-prompt-'));
  try {
    writeFileSync(join(cwd, 'AGENT.md'), 'first </document> & text');
    writeFileSync(join(cwd, 'AGENTS.md'), 'second');
    const prompt = buildSystemPrompt({
      rolePrompt: '<rules>role</rules>',
      cwd,
      skills: [],
      now: new Date(2026, 0, 1),
      shell: 'sh',
    });
    expect(prompt.startsWith(`${defaultSection}\n\n<role>\n<rules>role</rules>\n</role>`)).toBe(true);
    expect(prompt).toContain('<document source="AGENT.md">\nfirst &lt;/document&gt; &amp; text\n</document>');
    expect(prompt).toContain('<document source="AGENTS.md">\nsecond\n</document>');
    expect(prompt.indexOf('</role>')).toBeLessThan(prompt.indexOf('<project-instructions>'));
    expect(prompt.indexOf('</project-instructions>')).toBeLessThan(prompt.indexOf('<context>'));
    expect(buildSystemPrompt({ cwd, skills: [] })).not.toContain('<skills>');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

it('always keeps the built-in system section even if a caller passes the removed override field', () => {
  const options = { baseSystemPrompt: 'Override default.', projectInstructions: null, skills: [] };
  const prompt = buildSystemPrompt(options);
  expect(prompt.startsWith(defaultSection)).toBe(true);
  expect(prompt).not.toContain('Override default.');
  expect(prompt).not.toContain('<role>');
});

it('omits blank role additions and keeps the system prefix stable across roles', () => {
  const options = { projectInstructions: null, skills: [], now: new Date(2026, 0, 1), shell: 'sh' };
  const base = buildSystemPrompt(options);
  expect(base).not.toContain('<role>');
  expect(buildSystemPrompt({ ...options, rolePrompt: ' \n ' })).toBe(base);
  for (const rolePrompt of ['Review carefully.', 'Translate clearly.']) {
    const prompt = buildSystemPrompt({ ...options, rolePrompt });
    expect(prompt.startsWith(`${defaultSection}\n\n<role>\n${rolePrompt}\n</role>`)).toBe(true);
    expect(prompt.split(defaultSection)).toHaveLength(2);
    expect(prompt.indexOf('</role>')).toBeLessThan(prompt.indexOf('<context>'));
  }
});

it('expands brand placeholders in appended roles without changing unknown placeholders', () => {
  const rolePrompt = 'You are {{ MICA_APP_NAME }}. Keep {{ UNKNOWN_ROLE_VALUE }}.';
  const prompt = buildSystemPrompt({ rolePrompt, projectInstructions: null, skills: [] });
  expect(prompt).toContain(`<role>\n${applyBrandTemplate(rolePrompt)}\n</role>`);
  expect(prompt).not.toContain('{{ MICA_APP_NAME }}');
  expect(prompt).toContain('{{ UNKNOWN_ROLE_VALUE }}');
});

it('applies the user order to the assembled prompt and keeps the system section first', () => {
  const options = {
    rolePrompt: 'Role body.',
    projectInstructions: 'Project body.',
    skills: [],
    now: new Date(2026, 0, 1),
    shell: 'sh',
  };
  const promptControls = {
    version: 1 as const,
    disabledPlugins: [],
    sections: {},
    order: ['context', 'project-instructions', 'role'],
  };
  const prompt = buildSystemPrompt({ ...options, promptControls });
  expect(prompt.startsWith(defaultSection)).toBe(true);
  expect(prompt.indexOf('<context>')).toBeLessThan(prompt.indexOf('<project-instructions>'));
  expect(prompt.indexOf('<project-instructions>')).toBeLessThan(prompt.indexOf('<role>'));
  // 不使用自定义顺序时排列不变，避免改功能本身给提示词前缀带来无意义的抖动。
  const plain = buildSystemPrompt(options);
  expect(plain.indexOf('<role>')).toBeLessThan(plain.indexOf('<project-instructions>'));
});

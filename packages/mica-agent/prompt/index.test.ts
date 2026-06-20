import { describe, expect, it } from 'vitest';
import { buildSystemPromptForTest } from './index.js';

describe('buildSystemPrompt', () => {
  it('keeps stable sections in priority order with dynamic context last', () => {
    const prompt = buildSystemPromptForTest({
      cwd: '/repo',
      now: new Date('2026-06-17T10:20:30.000Z'),
      platform: 'darwin',
      shell: '/bin/zsh',
      projectInstructions: '- run typecheck',
      skills: [],
    });

    expect(prompt.indexOf('<system>')).toBeLessThan(prompt.indexOf('<project-instructions>'));
    expect(prompt.indexOf('<project-instructions>')).toBeLessThan(prompt.indexOf('<context>'));
    expect(prompt.trim().endsWith('</context>')).toBe(true);
  });

  it('injects project instructions and day-level environment context', () => {
    const prompt = buildSystemPromptForTest({
      cwd: '/repo',
      now: new Date('2026-06-17T10:20:30.000Z'),
      platform: 'darwin',
      shell: '/bin/zsh',
      projectInstructions: '- 不要使用动态导入',
      skills: [],
    });

    expect(prompt).toContain('<project-instructions>');
    expect(prompt).toContain('- 不要使用动态导入');
    expect(prompt).toContain('- 当前工作目录: /repo');
    expect(prompt).toContain('- 当前日期: 2026-06-17');
    expect(prompt).not.toContain('2026-06-17T10:20:30.000Z');
  });

  it('renders skills as an index instead of full skill content', () => {
    const prompt = buildSystemPromptForTest({
      cwd: '/repo',
      now: new Date('2026-06-17T10:20:30.000Z'),
      platform: 'darwin',
      shell: '/bin/zsh',
      projectInstructions: null,
      skills: [
        {
          name: 'review',
          description: 'Review code changes',
          whenToUse: 'When the user asks for a review',
          argumentHint: '[path]',
          content: 'Full skill instructions should not be injected eagerly.',
          baseDir: '/skills/review',
        },
      ],
    });

    expect(prompt).toContain('<skills>');
    expect(prompt).toContain('- review: Review code changes');
    expect(prompt).toContain('when_to_use: When the user asks for a review');
    expect(prompt).toContain('argument_hint: [path]');
    expect(prompt).not.toContain('Full skill instructions should not be injected eagerly.');
  });
});

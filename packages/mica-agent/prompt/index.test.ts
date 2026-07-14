import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSystemPromptForTest, readProjectInstructions } from './index.js';

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

  it('injects project instructions and month-level environment context', () => {
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
    expect(prompt).toContain('- 当前时间: 2026-06');
    expect(prompt).not.toContain('2026-06-17');
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

  it('renders skills index in stable name order', () => {
    const prompt = buildSystemPromptForTest({
      cwd: '/repo',
      now: new Date('2026-06-17T10:20:30.000Z'),
      platform: 'darwin',
      shell: '/bin/zsh',
      projectInstructions: null,
      skills: [
        {
          name: 'zeta',
          description: 'Zeta skill',
          content: '',
          baseDir: '/skills/zeta',
        },
        {
          name: 'alpha',
          description: 'Alpha skill',
          content: '',
          baseDir: '/skills/alpha',
        },
      ],
    });

    expect(prompt.indexOf('- alpha: Alpha skill')).toBeLessThan(prompt.indexOf('- zeta: Zeta skill'));
  });

  it('replaces only the base system section for a custom role', () => {
    const prompt = buildSystemPromptForTest({
      baseSystemPrompt: 'You are a focused reviewer.',
      cwd: '/repo',
      now: new Date('2026-06-17T10:20:30.000Z'),
      platform: 'darwin',
      shell: '/bin/zsh',
      projectInstructions: '- keep project rules',
      skills: [
        {
          name: 'review',
          description: 'Review code changes',
          content: 'Full instructions',
          baseDir: '/skills/review',
        },
      ],
    });

    expect(prompt).toContain('<system>\nYou are a focused reviewer.\n</system>');
    expect(prompt).toContain('<project-instructions>\n- keep project rules\n</project-instructions>');
    expect(prompt).toContain('<skills>');
    expect(prompt).toContain('- review: Review code changes');
    expect(prompt).toContain('<context>');
  });

  it('grounds tool names and distinguishes shell executables', () => {
    const prompt = buildSystemPromptForTest({
      cwd: '/repo',
      now: new Date('2026-06-17T10:20:30.000Z'),
      platform: 'darwin',
      shell: '/bin/zsh',
      projectInstructions: null,
      skills: [],
    });

    expect(prompt).toContain('当前工具 schema 是工具名称、参数和能力的最终事实来源');
    expect(prompt).toContain('`rg` 不是独立工具，也不保证已安装');
    expect(prompt).toContain('使用 `read_task_output` 查看输出');
    expect(prompt).not.toContain('在 shell 中搜索文本优先用 `rg`');
  });

  it('reads AGENT.md and Multica-compatible AGENTS.md from the requested cwd', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mica-project-instructions-'));
    try {
      writeFileSync(join(cwd, 'AGENT.md'), 'repository rule', 'utf-8');
      writeFileSync(join(cwd, 'AGENTS.md'), 'multica runtime brief', 'utf-8');

      const instructions = readProjectInstructions(cwd);
      expect(instructions).toContain('# AGENT.md\n\nrepository rule');
      expect(instructions).toContain('# AGENTS.md\n\nmultica runtime brief');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

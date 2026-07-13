import { describe, expect, it } from 'vitest';
import { RUN_SHELL_VERBOSE_LOG_THRESHOLD_MS, getToolIcon, shouldShowToolOutput } from './agentTurnLogItems.js';

describe('run shell tool output logs', () => {
  it('hides command output at or below the verbose threshold', () => {
    expect(
      shouldShowToolOutput({
        toolName: 'run_shell',
        output: '[stdout]\nfast output',
        elapsedMs: RUN_SHELL_VERBOSE_LOG_THRESHOLD_MS - 1,
      }),
    ).toBe(false);
    expect(
      shouldShowToolOutput({
        toolName: 'run_shell',
        output: '[stdout]\nfast output',
        elapsedMs: RUN_SHELL_VERBOSE_LOG_THRESHOLD_MS,
      }),
    ).toBe(false);
  });

  it('shows command output once the verbose threshold is exceeded', () => {
    expect(
      shouldShowToolOutput({
        toolName: 'run_shell',
        output: '[stdout]\nslow output',
        elapsedMs: RUN_SHELL_VERBOSE_LOG_THRESHOLD_MS + 1,
      }),
    ).toBe(true);
  });
});

describe('tool log icons', () => {
  it.each(['background_tasks', 'read_task_output', 'kill_task'])('uses a task icon for %s', (toolName) => {
    expect(getToolIcon(toolName)).toBe('📋');
  });
});

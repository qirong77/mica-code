import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandRuntimeServices } from './services.js';

const mocks = {
  gitText: vi.fn(),
  logRuntime: vi.fn(),
  readFileSync: vi.fn(),
  showMessage: vi.fn(),
  submit: vi.fn(),
  statSync: vi.fn(),
};

vi.mock('node:fs', () => ({
  readFileSync: mocks.readFileSync,
  statSync: mocks.statSync,
}));

vi.mock('@packages/mica-common/index.js', () => ({
  formatExecError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  gitText: mocks.gitText,
}));

vi.mock('@packages/mica-ui/index.js', () => ({
  micaUi: {
    dropdown: {
      setQuickCommands: vi.fn(),
    },
    terminalInput: {
      submit: mocks.submit,
    },
  },
}));

const { createReviewCommand } = await import('./review.js');

function makeServices(): CommandRuntimeServices {
  return {
    showMessage: mocks.showMessage,
  } as unknown as CommandRuntimeServices;
}

describe('review command', () => {
  beforeEach(() => {
    mocks.gitText.mockReset();
    mocks.logRuntime.mockReset();
    mocks.readFileSync.mockReset();
    mocks.showMessage.mockReset();
    mocks.submit.mockReset();
    mocks.statSync.mockReset();
  });

  it('sends current workspace changes for code review', () => {
    mocks.gitText.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse') return 'feature\n';
      if (args[0] === 'diff' && args[1] === '--cached') return 'diff --git a/staged b/staged\n+staged\n';
      if (args[0] === 'diff' && args.length === 1) return 'diff --git a/unstaged b/unstaged\n-unstaged\n';
      if (args[0] === 'ls-files') return 'new-file.ts\0';
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    });
    mocks.statSync.mockReturnValue({ isFile: () => true, size: 26 });
    mocks.readFileSync.mockReturnValue(Buffer.from('export const value = 1;\n'));

    createReviewCommand(makeServices()).action();

    expect(mocks.gitText).toHaveBeenCalledWith(['diff', '--cached'], { timeout: 10000 });
    expect(mocks.gitText).toHaveBeenCalledWith(['diff'], { timeout: 10000 });
    expect(mocks.gitText).toHaveBeenCalledWith(['ls-files', '--others', '--exclude-standard', '-z'], {
      timeout: 10000,
    });
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.stringContaining('请 review 当前工作区的代码变更。'),
      expect.objectContaining({ displayText: expect.stringContaining('已发送当前工作区 Git 变化给 agent review。') }),
    );
    expect(mocks.submit).toHaveBeenCalledWith(expect.stringContaining('# Staged changes'), expect.anything());
    expect(mocks.submit).toHaveBeenCalledWith(expect.stringContaining('# Unstaged changes'), expect.anything());
    expect(mocks.submit).toHaveBeenCalledWith(expect.stringContaining('# Untracked files'), expect.anything());
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.stringContaining('diff --git a/new-file.ts b/new-file.ts'),
      expect.anything(),
    );
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.stringContaining('优先关注 bug、行为回归、数据丢失风险、并发/状态问题和缺失测试'),
      expect.objectContaining({ displayText: expect.stringContaining('文件：3') }),
    );
    expect(mocks.showMessage).not.toHaveBeenCalled();
  });

  it('does not submit when the workspace has no git changes', () => {
    mocks.gitText.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse') return 'feature\n';
      if (args[0] === 'diff') return '';
      if (args[0] === 'ls-files') return '';
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    });

    createReviewCommand(makeServices()).action();

    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.showMessage).toHaveBeenCalledWith('review: branch feature has no current git changes', 5000);
  });
});

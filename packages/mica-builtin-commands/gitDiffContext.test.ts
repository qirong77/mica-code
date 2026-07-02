import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandRuntimeServices } from './services.js';

const mocks = {
  gitText: vi.fn(),
  logRuntime: vi.fn(),
  showMessage: vi.fn(),
  submit: vi.fn(),
};

vi.mock('@packages/mica-common/index.js', () => ({
  formatExecError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  gitText: mocks.gitText,
}));

vi.mock('@packages/mica-logger/index.js', () => ({
  micaLogger: {
    logRuntime: mocks.logRuntime,
  },
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

const { createGitDiffContextCommand } = await import('./gitDiffContext.js');

function makeServices(): CommandRuntimeServices {
  return {
    showMessage: mocks.showMessage,
  } as unknown as CommandRuntimeServices;
}

describe('git-diff-context command', () => {
  beforeEach(() => {
    mocks.gitText.mockReset();
    mocks.logRuntime.mockReset();
    mocks.showMessage.mockReset();
    mocks.submit.mockReset();
  });

  it('uses master as the default base branch', () => {
    mocks.gitText.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse') return 'feature\n';
      if (args[0] === 'diff' && args[1] === 'origin/master...HEAD') throw new Error('missing origin');
      if (args[0] === 'diff' && args[1] === 'master...HEAD') return 'diff --git a/file b/file\n';
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    });

    createGitDiffContextCommand(makeServices()).action();

    expect(mocks.gitText).toHaveBeenCalledWith(['diff', 'origin/master...HEAD'], { timeout: 10000 });
    expect(mocks.gitText).toHaveBeenCalledWith(['diff', 'master...HEAD'], { timeout: 10000 });
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.stringContaining('`feature` and `master`'),
      expect.objectContaining({ displayText: expect.stringContaining('已发送') }),
    );
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.stringContaining('diff --git a/file b/file'),
      expect.objectContaining({ displayText: expect.stringContaining('文件：1') }),
    );
    expect(mocks.showMessage).not.toHaveBeenCalled();
  });

  it('uses the first command argument as the base branch', () => {
    mocks.gitText.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse') return 'feature\n';
      if (args[0] === 'diff' && args[1] === 'origin/develop...HEAD') throw new Error('missing origin');
      if (args[0] === 'diff' && args[1] === 'develop...HEAD') return 'diff --git a/dev b/dev\n';
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    });

    createGitDiffContextCommand(makeServices()).action('develop extra');

    expect(mocks.gitText).toHaveBeenCalledWith(['diff', 'origin/develop...HEAD'], { timeout: 10000 });
    expect(mocks.gitText).toHaveBeenCalledWith(['diff', 'develop...HEAD'], { timeout: 10000 });
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.stringContaining('`feature` and `develop`'),
      expect.objectContaining({ displayText: expect.stringContaining('develop') }),
    );
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.stringContaining('diff --git a/dev b/dev'),
      expect.objectContaining({ displayText: expect.stringContaining('文件：1') }),
    );
    expect(mocks.submit).not.toHaveBeenCalledWith(expect.stringContaining('`feature` and `master`'), expect.anything());
  });

  it('sends current git changes when passed dash', () => {
    mocks.gitText.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse') return 'feature\n';
      if (args[0] === 'diff' && args[1] === '--cached') return 'diff --git a/staged b/staged\n';
      if (args[0] === 'diff' && args.length === 1) return 'diff --git a/unstaged b/unstaged\n';
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    });

    createGitDiffContextCommand(makeServices()).action('-');

    expect(mocks.gitText).toHaveBeenCalledWith(['diff', '--cached'], { timeout: 10000 });
    expect(mocks.gitText).toHaveBeenCalledWith(['diff'], { timeout: 10000 });
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.stringContaining('current git changes on branch `feature`'),
      expect.objectContaining({ displayText: expect.stringContaining('当前工作区 Git 变化') }),
    );
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.stringContaining('# Staged changes'),
      expect.objectContaining({ displayText: expect.stringContaining('文件：2') }),
    );
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.stringContaining('diff --git a/staged b/staged'),
      expect.anything(),
    );
    expect(mocks.submit).toHaveBeenCalledWith(expect.stringContaining('# Unstaged changes'), expect.anything());
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.stringContaining('diff --git a/unstaged b/unstaged'),
      expect.anything(),
    );
    expect(mocks.showMessage).not.toHaveBeenCalled();
  });
});

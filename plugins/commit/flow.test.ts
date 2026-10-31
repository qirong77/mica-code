import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPluginLlmApi, type PluginModelRequest } from '@packages/mica-plugin/index.js';
import { runCommitFlow } from './flow.js';
import { DEFAULT_PROMPT } from './message.js';
import * as gitHelpers from './git.js';

const repos: string[] = [];
let repo = '';

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mica-commit-plugin-'));
  repos.push(directory);
  git(['init', '-q'], directory);
  git(['config', 'user.name', 'Mica Commit Test'], directory);
  git(['config', 'user.email', 'commit-plugin@example.invalid'], directory);
  git(['config', 'commit.gpgsign', 'false'], directory);
  writeFileSync(join(directory, 'README.md'), 'initial\n');
  git(['add', 'README.md'], directory);
  git(['commit', '-qm', 'chore: initialize test repo'], directory);
  return directory;
}

/** 假的模型底层：记录 user 正文（摘要），按脚本返回文本或抛错。 */
function fakeLlm(reply: string | Error, beforeReply?: () => void) {
  const calls: PluginModelRequest[] = [];
  const llm = createPluginLlmApi({
    spec: {},
    readValues: () => ({ baseUrl: 'https://api.example.test/v1', apiKey: 'test-key', model: 'mini' }),
    models: async (request) => {
      calls.push(request);
      if (reply instanceof Error) throw reply;
      beforeReply?.();
      return { text: reply, usage: null };
    },
  });
  return { llm, calls };
}

const message = { prompt: DEFAULT_PROMPT };

beforeEach(() => {
  repo = makeRepo();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of repos.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('commit flow', () => {
  it('同仓库并发提交返回 busy，失败释放锁后可重试', async () => {
    writeFileSync(join(repo, 'README.md'), 'pending model request\n');
    const { llm } = fakeLlm('fix: retry');
    let reject!: (error: Error) => void;
    let started!: () => void;
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(llm, 'request').mockImplementationOnce(() => {
      started();
      return new Promise((_resolve, fail) => {
        reject = fail;
      });
    });
    const first = runCommitFlow({ cwd: repo, message, llm, push: false });
    await requested;
    const second = fakeLlm('must not request');
    try {
      expect(await runCommitFlow({ cwd: repo, message, llm: second.llm, push: false })).toMatchObject({
        ok: false,
        code: 'busy',
      });
      expect(second.calls).toHaveLength(0);
    } finally {
      reject(new Error('mock model failed'));
      expect(await first).toMatchObject({ ok: false, error: expect.stringContaining('mock model failed') });
    }
    expect(git(['diff', '--cached', '--name-only'])).toBe('');
    expect(await runCommitFlow({ cwd: repo, message, llm, push: false })).toMatchObject({ ok: true });
  });
  it('模型请求期间即使同一路径状态未变，内容改变也拒绝暂存和提交', async () => {
    writeFileSync(join(repo, 'README.md'), 'before model request\n');
    const head = git(['rev-parse', 'HEAD']);
    const { llm } = fakeLlm('fix: 旧改动 🐛', () =>
      writeFileSync(join(repo, 'README.md'), 'changed during model request\n'),
    );
    const result = await runCommitFlow({ cwd: repo, message, llm, push: false });
    expect(result).toMatchObject({ ok: false, code: 'worktree_changed' });
    expect(git(['rev-parse', 'HEAD'])).toBe(head);
    expect(git(['diff', '--cached', '--name-only'])).toBe('');
  });

  it('未跟踪符号链接只摘要链接本身，不读取链接指向的外部文件', async () => {
    const target = join(makeRepo(), 'private.txt');
    writeFileSync(target, 'external-file-content-canary\n');
    symlinkSync(target, join(repo, 'external-link'));
    const { llm, calls } = fakeLlm('chore: 增加链接 🔧');
    const result = await runCommitFlow({ cwd: repo, message, llm, push: false });
    expect(result.ok).toBe(true);
    expect(calls[0]?.user).toContain('[symbolic link]');
    expect(calls[0]?.user).not.toContain('external-file-content-canary');
  });
  it('从子目录调用时摘要与提交都覆盖整仓库，并读取特殊路径的未跟踪正文', async () => {
    const nested = join(repo, 'nested');
    mkdirSync(nested);
    writeFileSync(join(repo, '中文 file -> new.txt'), 'unique untracked content outside nested directory\n');
    writeFileSync(join(nested, 'new.txt'), 'nested file\n');
    const { llm, calls } = fakeLlm('feat: 提交整仓库变化 ✨');
    const result = await runCommitFlow({ cwd: nested, message, llm, push: false });
    expect(result.ok).toBe(true);
    expect(calls[0]?.user).toContain('unique untracked content outside nested directory');
    expect(calls[0]?.user).toContain('nested file');
    expect(git(['status', '--porcelain'])).toBe('');
  });

  it('推送失败时仍然返回已完成的提交信息，便于只重试推送', async () => {
    writeFileSync(join(repo, 'README.md'), 'must commit before push fails\n');
    vi.spyOn(gitHelpers, 'pushCurrentBranch').mockRejectedValue(new Error('mock remote unavailable'));
    const result = await runCommitFlow({ cwd: repo, message, llm: fakeLlm('fix: 保存本地改动 🐛').llm, push: true });
    expect(result).toMatchObject({ ok: false, code: 'push_failed', pushed: false, subject: 'fix: 保存本地改动 🐛' });
    expect(result.commitHash).toBe(git(['rev-parse', '--short', 'HEAD']).trim());
    expect(result.error).toContain('已提交');
    expect(result.error).toContain('git push');
    expect(git(['status', '--porcelain'])).toBe('');
  });
  it('commits the working tree with the generated message and reports progress in order', async () => {
    writeFileSync(join(repo, 'README.md'), 'updated\n');
    writeFileSync(join(repo, 'notes.txt'), 'new file\n');
    const progress: string[] = [];
    const { llm, calls } = fakeLlm('fix: 更新说明文件 🐛');

    const result = await runCommitFlow({
      cwd: repo,
      message,
      llm,
      push: false,
      onProgress: (text) => progress.push(text),
    });

    expect(result).toMatchObject({ ok: true, subject: 'fix: 更新说明文件 🐛', pushed: false });
    expect(result.commitHash).toBeTruthy();
    expect(git(['log', '-1', '--pretty=%s']).trim()).toBe('fix: 更新说明文件 🐛');
    expect(git(['status', '--porcelain'])).toBe('');
    // 摘要里要能看到真实文件名，模型才有依据写消息。
    expect(calls).toHaveLength(1);
    expect(calls[0]!.user).toContain('README.md');
    expect(calls[0]!.user).toContain('notes.txt');
    expect(progress[0]).toContain('正在分析');
    expect(progress.at(-1)).toContain('fix: 更新说明文件 🐛');
  });

  it('never leaves a commit behind when the model request fails', async () => {
    writeFileSync(join(repo, 'README.md'), 'change that must stay uncommitted\n');
    const head = git(['rev-parse', 'HEAD']).trim();

    const result = await runCommitFlow({
      cwd: repo,
      message,
      llm: fakeLlm(new Error('commit message 请求无法完成：mock provider failed')).llm,
      push: false,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('mock provider failed');
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(head);
    expect(git(['status', '--porcelain'])).toContain('README.md');
  });

  it('returns nothing_to_commit without asking the model', async () => {
    const { llm, calls } = fakeLlm('chore: 空提交 🔧');
    const result = await runCommitFlow({
      cwd: repo,
      message,
      llm,
      push: false,
    });

    expect(result).toMatchObject({ ok: false, code: 'nothing_to_commit' });
    expect(calls).toHaveLength(0);
  });

  it('refuses to stage while the working tree still has conflicts', async () => {
    git(['checkout', '-qb', 'side']);
    writeFileSync(join(repo, 'README.md'), 'from side\n');
    git(['add', 'README.md']);
    git(['commit', '-qm', 'side change']);
    git(['checkout', '-q', '-']);
    writeFileSync(join(repo, 'README.md'), 'from base\n');
    git(['add', 'README.md']);
    git(['commit', '-qm', 'base change']);
    // 冲突是预期结果：merge 带冲突退出码 1。
    spawnSync('git', ['merge', 'side'], { cwd: repo, stdio: 'ignore' });

    const result = await runCommitFlow({
      cwd: repo,
      message,
      llm: fakeLlm('fix: 冲突 🐛').llm,
      push: false,
    });

    expect(result).toMatchObject({ ok: false, code: 'unmerged' });
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toContain('<<<<<<<');
  });
});

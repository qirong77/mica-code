import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPluginLlmApi, type PluginModelRequest } from '@packages/mica-plugin/index.js';
import { runCommitFlow } from './flow.js';
import { DEFAULT_PROMPT } from './message.js';

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
function fakeLlm(reply: string | Error) {
  const calls: PluginModelRequest[] = [];
  const llm = createPluginLlmApi({
    spec: {},
    readValues: () => ({ baseUrl: 'https://api.example.test/v1', apiKey: 'test-key', model: 'mini' }),
    models: async (request) => {
      calls.push(request);
      if (reply instanceof Error) throw reply;
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
  for (const directory of repos.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('commit flow', () => {
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

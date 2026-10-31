import { formatExecError } from '@packages/mica-common/index.js';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { join } from 'node:path';
import type { PluginLlmApi } from '@packages/mica-plugin/index.js';
import { commitWithMessage, git, hasUnmergedFiles, pushCurrentBranch, safeGit, worktreeFingerprint } from './git.js';
import { requestCommitMessage, type MessageRequestConfig } from './message.js';
import { buildChangeSummary } from './summary.js';

/**
 * 一次完整的提交流程。
 *
 * 顺序刻意固定：先把工作区改动摘要交给模型（这时还没 `git add`，未跟踪/已暂存/未暂存
 * 三类都看得到），拿到 message 之后才 add / commit / push。模型那一步失败时工作区
 * 保持原样，用户还能重新挑文件提交。
 *
 * 每一步都用 `onProgress` 说一声：推送可能十几秒，没有反馈时用户只会以为卡住了。
 */

export type CommitFlowCode = 'nothing_to_commit' | 'unmerged' | 'nothing_staged' | 'worktree_changed' | 'push_failed' | 'busy';

export type CommitFlowResult = {
  ok: boolean;
  code?: CommitFlowCode;
  error?: string;
  commitHash?: string;
  subject?: string;
  commitMessage?: string;
  pushed?: boolean;
};

export type CommitFlowOptions = {
  cwd: string;
  message: MessageRequestConfig;
  /** 模型接口（`ctx.llm`）：接口配置、请求与用量记账都走它。 */
  llm: PluginLlmApi;
  /** 提交成功后是否推送。 */
  push: boolean;
  onProgress?: (text: string) => void;
};

export async function runCommitFlow(options: CommitFlowOptions): Promise<CommitFlowResult> {
  const report = options.onProgress ?? (() => {});
  let release: (() => void) | null = null;

  try {
    // porcelain 的路径以仓库根为准，add -A 也覆盖整仓库；分析与提交必须使用同一个范围。
    const cwd = git(['rev-parse', '--show-toplevel'], options.cwd).trim();
    const gitDirectory = git(['rev-parse', '--absolute-git-dir'], cwd).trim();
    release = acquireProcessLock(join(gitDirectory, 'mica-commit.lock'));
    if (!release) return { ok: false, code: 'busy', error: '这个仓库正在执行 commit，请等当前操作结束后再重试' };
    report('commit: 正在分析 git 变化...');
    const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd);
    if (!status.trim()) {
      return { ok: false, code: 'nothing_to_commit', error: '没有可提交的变化' };
    }
    if (hasUnmergedFiles(status)) {
      return { ok: false, code: 'unmerged', error: '存在未解决冲突，请先处理' };
    }

    const fingerprint = await worktreeFingerprint(cwd, status);
    const summary = await buildChangeSummary(cwd, status);
    report('commit: 正在生成提交信息...');
    const commitMessage = await requestCommitMessage(options.llm, options.message, summary);
    report(`commit: ${firstLine(commitMessage)}`);

    const currentStatus = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd);
    if (!currentStatus.trim()) {
      return { ok: false, code: 'nothing_staged', error: '生成提交信息期间变化已被撤回，没有可提交的内容' };
    }
    if (fingerprint !== (await worktreeFingerprint(cwd, currentStatus))) {
      return {
        ok: false,
        code: 'worktree_changed',
        error: '生成提交信息期间工作区或暂存区发生变化，请重新执行 commit 分析最新改动',
      };
    }

    git(['add', '-A'], cwd);
    const staged = git(['diff', '--cached', '--name-only'], cwd);
    if (!staged.trim()) {
      return { ok: false, code: 'nothing_staged', error: 'git add 后没有 staged 变化' };
    }

    commitWithMessage(commitMessage, cwd);
    const commitHash = safeGit(['rev-parse', '--short', 'HEAD'], cwd).trim();
    const subject = firstLine(commitMessage);

    if (!options.push) {
      return { ok: true, commitHash, subject, commitMessage, pushed: false };
    }

    report(`commit: 已提交 ${commitHash}，正在 push...`);
    try {
      const pushed = await pushCurrentBranch(cwd);
      return { ok: true, commitHash, subject, commitMessage, pushed };
    } catch (error) {
      return {
        ok: false,
        code: 'push_failed',
        commitHash,
        subject,
        commitMessage,
        pushed: false,
        error: `已提交 ${commitHash}，但推送失败：${formatExecError(error)}。修复远程连接后可直接重试 git push。`,
      };
    }
  } catch (error) {
    return { ok: false, error: formatExecError(error) };
  } finally {
    release?.();
  }
}

function firstLine(message: string): string {
  return message.split('\n')[0]?.trim() || message.trim();
}

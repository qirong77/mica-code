import { formatExecError } from '@packages/mica-common/index.js';
import type { PluginLlmApi } from '@packages/mica-plugin/index.js';
import { commitWithMessage, git, hasUnmergedFiles, pushCurrentBranch, safeGit } from './git.js';
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

export type CommitFlowCode = 'nothing_to_commit' | 'unmerged' | 'nothing_staged';

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
  const { cwd } = options;
  const report = options.onProgress ?? (() => {});

  try {
    report('commit: 正在分析 git 变化...');
    const status = git(['status', '--porcelain=v1'], cwd);
    if (!status.trim()) {
      return { ok: false, code: 'nothing_to_commit', error: '没有可提交的变化' };
    }
    if (hasUnmergedFiles(status)) {
      return { ok: false, code: 'unmerged', error: '存在未解决冲突，请先处理' };
    }

    const summary = await buildChangeSummary(cwd, status);
    report('commit: 正在生成提交信息...');
    const commitMessage = await requestCommitMessage(options.llm, options.message, summary);
    report(`commit: ${firstLine(commitMessage)}`);

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
    const pushed = await pushCurrentBranch(cwd);
    return { ok: true, commitHash, subject, commitMessage, pushed };
  } catch (error) {
    return { ok: false, error: formatExecError(error) };
  }
}

function firstLine(message: string): string {
  return message.split('\n')[0]?.trim() || message.trim();
}

import { resolve } from 'node:path';
import setupModelEffortContext from '../../buildin-plugins/model-effort-context/index.mjs';
import { micaConfig } from '@packages/mica-config/index.js';
import { formatExecError, gitText } from '@packages/mica-common/index.js';
import {
  buildChangeSummary,
  commitWithMessage,
  generateCommitMessage,
  hasUnmergedFiles,
  pushCurrentBranch,
} from '@packages/mica-builtin-commands/index.js';
import { AgentRuntime } from '../agent/AgentRuntime.js';

export type CommitCliOptions = {
  cwd?: string;
  signal?: AbortSignal;
};

export type CommitCliResult = {
  ok: boolean;
  code?: 'nothing_to_commit' | 'unmerged' | 'nothing_staged' | 'error';
  error?: string;
  commitHash?: string;
  subject?: string;
  commitMessage?: string;
  pushed?: boolean;
};

// One-shot git commit: collect the change summary deterministically, ask the
// model a single time for the message, then run add/commit/push ourselves.
// Unlike `mica exec`, no tools are enabled and no multi-turn loop happens.
export async function runCommit(options: CommitCliOptions): Promise<CommitCliResult> {
  if (options.cwd) process.chdir(resolve(options.cwd));
  const disposeModelEffortContext = setupModelEffortContext();
  let agent: AgentRuntime | null = null;
  try {
    const status = gitText(['status', '--porcelain=v1']);
    if (!status.trim()) {
      return { ok: false, code: 'nothing_to_commit', error: '没有可提交的变化' };
    }
    if (hasUnmergedFiles(status)) {
      return { ok: false, code: 'unmerged', error: '存在未解决冲突，请先处理' };
    }

    const summary = await buildChangeSummary(status);

    await ensureCommitModelRule(micaConfig.get().model, options.signal);
    agent = new AgentRuntime({});
    await ensureCommitModelRule(agent.config.model, options.signal);
    agent.configureForRun(
      {
        providerId: agent.config.provider.id,
        model: agent.config.model,
        effort: agent.config.effort,
      },
      true,
    );

    const commitMessage = await generateCommitMessage(agent, summary);

    gitText(['add', '-A']);
    const stagedStatus = gitText(['diff', '--cached', '--name-only']);
    if (!stagedStatus.trim()) {
      return { ok: false, code: 'nothing_staged', error: 'git add 后没有 staged 变化' };
    }

    commitWithMessage(commitMessage);
    const commitHash = gitText(['rev-parse', '--short', 'HEAD']).trim();
    const pushed = await pushCurrentBranch();
    const subject = commitMessage.split('\n')[0]?.trim() || commitMessage.trim();
    return { ok: true, commitHash, subject, commitMessage, pushed };
  } catch (error) {
    return { ok: false, code: 'error', error: formatExecError(error) };
  } finally {
    disposeModelEffortContext();
  }
}

async function ensureCommitModelRule(model: string, signal?: AbortSignal): Promise<void> {
  try {
    await micaConfig.ensureModelRule(model, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    console.error(
      `Model metadata unavailable for ${model}; using generic defaults: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

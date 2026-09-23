import { resolve } from 'node:path';
import { buildSubagentUsageRecord, type AgentUsageRecord } from '@packages/mica-agent/index.js';
import setupModelEffortContext from '@packages/mica-builtin-commands/startup/model-effort-context/index.js';
import { micaConfig } from '@packages/mica-config/index.js';
import { formatExecError, gitText } from '@packages/mica-common/index.js';
import { micaSession } from '@packages/mica-session/index.js';
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
  /** 归属会话：把这次 commit message 请求的用量记进该会话（桌面端按钮会带上）。 */
  sessionId?: string;
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

    const startedAt = new Date().toISOString();
    const { message: commitMessage, requests } = await generateCommitMessage(agent, summary);
    // 请求已经发生（也可能已经计费），后面的 git 步骤成不成功都要记账。
    recordCommitMessageUsage(options.sessionId, requests, agent.config.model, startedAt);

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

/**
 * 把 commit message 那次请求记进归属会话的 `subagentUsageHistory`：commit 是一次性
 * 进程，不写回会话这次开销就永远丢了。
 *
 * 读-改-写只发生在模型请求结束之后，且中间没有 await，尽量缩小与正在写同一会话的
 * host（app-server / TUI）抢快照的窗口。归属会话不存在或不是 version 1 会话时静默跳过。
 */
function recordCommitMessageUsage(
  sessionId: string | undefined,
  requests: AgentUsageRecord[],
  model: string | undefined,
  startedAt: string,
): void {
  if (!sessionId || requests.length === 0) return;
  try {
    const store = micaSession.createStore();
    const session = store.load(sessionId);
    if (!session) return;
    const finishedAt = new Date().toISOString();
    store.save({
      ...session,
      revision: (session.revision ?? 0) + 1,
      updatedAt: finishedAt,
      snapshot: {
        ...session.snapshot,
        subagentUsageHistory: [
          ...(session.snapshot.subagentUsageHistory ?? []),
          buildSubagentUsageRecord({
            taskId: 'commit-message',
            subagentType: 'commit',
            description: '生成 commit message',
            model,
            effort: 'none',
            status: 'completed',
            startedAt,
            finishedAt,
            requests,
          }),
        ],
      },
    });
  } catch (error) {
    // 记账失败不能连带让 commit 失败。
    console.error(`Failed to record commit usage: ${formatExecError(error)}`);
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

import { execFileSync } from 'node:child_process';
import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent, CommandRuntimeServices } from '../services.js';
import { formatExecError } from '@packages/mica-common/index.js';
import type { AgentChangeTracker } from '../git/agentChangeTracker.js';
import {
  buildChangeSummary,
  commitWithMessage,
  generateCommitMessage,
  git,
  hasUnmergedFiles,
  pushCurrentBranch,
} from '../git/commitRunner.js';

export function createCommitCommand(
  agent: CommandAgent,
  services: CommandRuntimeServices,
  tracker?: AgentChangeTracker,
) {
  return {
    name: 'commit',
    description: '分析 Git 变化并提交；使用 `agent` 参数仅提交当前 Agent 的改动',
    completionItems: [{ arg: 'agent', description: '仅提交当前 Agent 的改动' }],
    action: async (arg?: string) => {
      const targetAgent = services.getCurrentAgent() ?? agent;
      const ownerSessionId = services.getCurrentAgentSessionId();
      const mode = arg?.trim().toLowerCase();
      if (mode && mode !== 'agent') {
        showCommitMessage(services, `commit: 不支持参数 ${arg}`, ownerSessionId, 'error');
        return;
      }
      if (mode === 'agent') {
        await runAgentCommit(targetAgent, services, tracker, ownerSessionId);
        return;
      }
      await runCommit(targetAgent, services, ownerSessionId);
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

async function runAgentCommit(
  agent: CommandAgent,
  services: CommandRuntimeServices,
  tracker: AgentChangeTracker | undefined,
  ownerSessionId?: string,
) {
  if (!tracker || !agent.taskOwnerId) {
    showCommitMessage(services, 'commit: Agent 变更追踪器不可用', ownerSessionId, 'error');
    return;
  }

  let prepared: ReturnType<AgentChangeTracker['prepareIndex']> | undefined;
  try {
    setCommitStatus(agent, services, 'commit agent: 正在整理当前 Agent 的改动...', ownerSessionId);
    prepared = tracker.prepareIndex(agent.taskOwnerId);
    const summary = buildAgentChangeSummary(prepared.indexPath, prepared.files);
    const commitMessage = await generateCommitMessage(agent, summary);
    setCommitStatus(agent, services, `commit agent: ${firstLine(commitMessage)}`, ownerSessionId);
    commitWithMessage(commitMessage, prepared.indexPath);
    prepared.finish();

    const commitHash = git(['rev-parse', '--short', 'HEAD']).trim();
    setCommitStatus(agent, services, `commit agent: 已提交 ${commitHash}，正在 push...`, ownerSessionId);
    const pushed = await pushCurrentBranch();
    const subject = firstLine(commitMessage);
    services.showCommitNotice(
      pushed ? `已提交并推送 \`${commitHash}\`  ${subject}` : `已提交 \`${commitHash}\`，未找到远程分支  ${subject}`,
      ownerSessionId,
    );
  } catch (error) {
    showCommitMessage(services, `commit agent failed: ${formatExecError(error)}`, ownerSessionId, 'error');
  } finally {
    prepared?.dispose();
  }
}

function buildAgentChangeSummary(indexPath: string, files: string[]): string {
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  const run = (args: string[]) =>
    execFileSync('git', args, { encoding: 'utf8', env, maxBuffer: 10 * 1024 * 1024 }).trim();
  return truncate(
    [
      'Git status summary:',
      `total files: ${files.length}`,
      '',
      'Changed files:',
      files.join('\n'),
      '',
      'Diff stat:',
      run(['diff', '--cached', '--stat', '--no-color']) || '(empty)',
      '',
      'Name status:',
      run(['diff', '--cached', '--name-status', '--no-color']) || '(empty)',
      '',
      'Compact diff samples:',
      truncate(run(['diff', '--cached', '--unified=0', '--no-color']), MAX_TOTAL_DIFF_CHARS),
    ].join('\n'),
    MAX_SUMMARY_CHARS,
  );
}

const MAX_SUMMARY_CHARS = 20_000;
const MAX_TOTAL_DIFF_CHARS = 12_000;

function setCommitStatus(agent: CommandAgent, services: CommandRuntimeServices, text: string, ownerSessionId?: string) {
  services.setPluginStatus(agent, text, {
    ownerSessionId,
    surface: 'command_panel',
    command: '/commit',
    variant: 'commit',
  });
}

function showCommitMessage(
  services: CommandRuntimeServices,
  text: string,
  ownerSessionId?: string,
  status: 'info' | 'warning' | 'error' = 'info',
) {
  services.showNotice(text, ownerSessionId, {
    command: '/commit',
    variant: 'commit',
    status,
  });
}

async function runCommit(agent: CommandAgent, services: CommandRuntimeServices, ownerSessionId?: string) {
  try {
    setCommitStatus(agent, services, 'commit: 正在分析 git 变化...', ownerSessionId);

    const status = git(['status', '--porcelain=v1']);
    if (!status.trim()) {
      showCommitMessage(services, 'commit: 没有可提交的变化', ownerSessionId, 'info');
      return;
    }
    if (hasUnmergedFiles(status)) {
      showCommitMessage(services, 'commit: 存在未解决冲突，请先处理', ownerSessionId, 'error');
      return;
    }

    const summary = await buildChangeSummary(status);
    const commitMessage = await generateCommitMessage(agent, summary);

    setCommitStatus(agent, services, `commit: ${firstLine(commitMessage)}`, ownerSessionId);
    git(['add', '-A']);

    const stagedStatus = git(['diff', '--cached', '--name-only']);
    if (!stagedStatus.trim()) {
      showCommitMessage(services, 'commit: git add 后没有 staged 变化', ownerSessionId, 'warning');
      return;
    }

    commitWithMessage(commitMessage);
    const commitHash = git(['rev-parse', '--short', 'HEAD']).trim();

    setCommitStatus(agent, services, `commit: 已提交 ${commitHash}，正在 push...`, ownerSessionId);
    const pushed = await pushCurrentBranch();

    const commitSubject = commitMessage.split('\n')[0]?.trim() || commitMessage.trim();
    const messageLines = [
      pushed
        ? `已提交并推送 \`${commitHash}\`  ${commitSubject}`
        : `已提交 \`${commitHash}\`，未找到远程分支  ${commitSubject}`,
    ];
    if (!pushed && commitMessage.split('\n').length > 1) {
      messageLines.push('');
      messageLines.push(commitMessage.split('\n').slice(1).join('\n').trim());
    }
    services.showCommitNotice(messageLines.join('\n'), ownerSessionId);
  } catch (error) {
    const message = formatExecError(error);
    showCommitMessage(services, `commit failed: ${message}`, ownerSessionId, 'error');
  }
}

function truncate(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 80))}\n[truncated ${text.length - maxChars} chars]`;
}

function firstLine(text: string) {
  return (
    text
      .split('\n')
      .find((line) => line.trim())
      ?.trim() || '(empty)'
  );
}

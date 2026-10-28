import type {
  CommandAgent,
  CommandRuntimeServices,
  CommandSessionController,
  SubagentTaskSummary,
} from '@packages/mica-builtin-commands/index.js';
import type { SubmitResult } from '@packages/mica-runtime/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import type { SubagentTaskManager } from '../agents/SubagentTaskManager.js';
import type { SessionController } from '../session/SessionController.js';
import { toCompactedConversationDisplay } from '../plugins/commands/compactConversation.js';
import type { TurnNoticeLog } from '../runtime/turnNotices.js';

export type HeadlessRuntimeServicesOptions = {
  agent: AgentRuntime;
  sessionController: SessionController;
  subagentTasks: SubagentTaskManager;
  /** Session notices (retry hints, failures, command results) kept out of the provider history. */
  notices: { ensure(): TurnNoticeLog };
  isBusy: () => boolean;
  submit: (
    text: string,
    options?: { queueMode?: 'after_iteration' | 'after_turn'; displayText?: string },
  ) => Promise<SubmitResult>;
};

/** Notices appended to the conversation; cleared by rewrite (like the UI). */
export function createHeadlessRuntimeServices(options: HeadlessRuntimeServicesOptions): CommandRuntimeServices {
  const { agent, sessionController, subagentTasks } = options;
  const noticeLog = (): TurnNoticeLog => options.notices.ensure();

  const save = (extra?: { allowEmpty?: boolean; turnState?: 'completed' | 'aborted' | 'error' | 'running' }): void => {
    sessionController.saveCurrent({
      ...extra,
      conversationMessages: noticeLog().compose(),
    });
  };

  return {
    clearUI(_agent, targetSessionController) {
      (targetSessionController ?? sessionController).startNewSession();
      agent.clearSession();
      noticeLog().clear();
      save({ allowEmpty: true });
    },
    clearSubagentTasks(targetAgent) {
      return subagentTasks.killForOwner(targetAgent as AgentRuntime, 'Session was cleared.');
    },
    showMessage() {
      // No message bar in headless mode; notices are surfaced as conversation messages.
    },
    showNotice(text, _ownerSessionId, noticeOptions = {}) {
      noticeLog().upsert({
        role: 'notice',
        content: text,
        variant: noticeOptions.variant,
        command: noticeOptions.command,
        status: noticeOptions.status,
      });
      save({ allowEmpty: true });
    },
    showCommitNotice(text) {
      noticeLog().upsert({
        role: 'notice',
        content: text,
        variant: 'commit',
        command: '/commit',
        status: 'success',
      });
      save({ allowEmpty: true });
    },
    setPluginStatus() {},
    clearPluginStatus() {},
    syncModelDisplay() {},
    async ensureModelRule(model) {
      const { micaConfig } = await import('@packages/mica-config/index.js');
      await micaConfig.ensureModelRule(model, undefined, micaConfig.providerForModel(model));
    },
    async startConfigWeb() {
      throw new Error('/config is not available in headless mode');
    },
    isAgentRunning() {
      return options.isBusy();
    },
    isAgentBusy() {
      return options.isBusy();
    },
    hasBusyAgents() {
      return options.isBusy();
    },
    getCurrentAgentSessionId() {
      return sessionController.getCurrentSessionId();
    },
    getCurrentAgent() {
      return agent as CommandAgent;
    },
    getCurrentSessionController() {
      return sessionController as CommandSessionController;
    },
    renameCurrentAgentSession(title) {
      sessionController.renameCurrent(title);
    },
    listRunningAgents() {
      return [];
    },
    listSubagentTasks(): SubagentTaskSummary[] {
      return [];
    },
    getSubagentTask() {
      return undefined;
    },
    clearIdleAgents() {
      return { cleared: [], remaining: [] };
    },
    async requestExit() {},
    newAgentSession(): never {
      throw new Error('/new is not available in headless mode');
    },
    async submitAgentSessionInput(id, text, submitOptions) {
      if (id !== sessionController.getCurrentSessionId()) {
        return { ok: false, reason: 'error', error: new Error(`Unknown session: ${id}`) };
      }
      return options.submit(text, submitOptions);
    },
    forkCurrentAgent(): never {
      throw new Error('/fork is not available in headless mode');
    },
    switchAgentSession(): never {
      throw new Error('switchAgentSession is not available in headless mode');
    },
    refreshCurrentAgentSessionUi() {},
    listRewindCheckpoints() {
      return [];
    },
    getRewindPreview() {
      return { ok: false, message: '/rewind is not available in headless mode' };
    },
    applyRewind(): never {
      throw new Error('/rewind is not available in headless mode');
    },
    clearRewindCheckpoints() {},
    async runExclusiveTask(_agent, _options, task) {
      return task();
    },
    async compact(targetAgent, targetSessionController, ownerSessionId, compactOptions) {
      const { micaContext } = await import('@packages/mica-context/index.js');
      const concreteAgent = targetAgent as AgentRuntime;
      const snapshot = concreteAgent.getSnapshot();
      const service = new micaContext.CompactionService();
      const result = await service.compact({
        messages: snapshot.messages,
        options: compactOptions,
        summarize: async () => {
          throw new Error('compact in headless mode must not summarize');
        },
      });
      await this.applySessionHistory?.(concreteAgent, targetSessionController, ownerSessionId, {
        messages: result.messages,
        beforeCount: result.beforeCount,
      });
      return result;
    },
    async applySessionHistory(targetAgent, targetSessionController, _ownerSessionId, historyOptions) {
      const concreteAgent = targetAgent as AgentRuntime;
      const concreteSessionController = targetSessionController as SessionController;
      const clientSnapshot = concreteAgent.captureClientSnapshot();
      if (!clientSnapshot || clientSnapshot.messages.length === 0) {
        throw new Error('没有可替换的历史');
      }
      try {
        concreteAgent.restoreClientSnapshot({
          ...clientSnapshot,
          messages: historyOptions.messages,
          // Keep usage statistics across rewrite: clearing them would drop
          // pre-rewrite token usage from Stats and the platform reconciliation.
          usageHistory: clientSnapshot.usageHistory,
          lastUsage: clientSnapshot.lastUsage,
        });
      } catch (error) {
        concreteAgent.restoreClientSnapshot(clientSnapshot);
        throw error;
      }
      const appliedMessages = concreteAgent.getSnapshot().messages;
      const compacted = toCompactedConversationDisplay(concreteAgent.toConversationMessages());
      if (appliedMessages.length === 0 || compacted.length === 0) {
        concreteAgent.restoreClientSnapshot(clientSnapshot);
        throw new Error(
          'History replacement removed all usable conversation content; the original session was restored',
        );
      }
      // Rewriting the history drops the notices with it (same as the CLI).
      noticeLog().clear();
      concreteSessionController.saveCurrent({
        preserveTitle: true,
        conversationMessages: compacted,
      });
      return { beforeCount: historyOptions.beforeCount, afterCount: appliedMessages.length };
    },
  };
}

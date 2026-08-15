import { calculateCachedTokenRate, type AgentUsageRecord } from '@packages/mica-agent/index.js';
import type { Disposable } from '@packages/mica-common/index.js';
import { micaUi, type MicaUiBackgroundTaskItem, type MicaUiSubagentTaskItem } from '@packages/mica-ui/index.js';
import {
  cleanBackgroundTaskOutput,
  getBackgroundTaskOutputSize,
  listBackgroundTasks,
  readBackgroundTaskOutput,
  ToolRunShell,
  type BackgroundTaskMeta,
} from '@packages/mica-tools/index.js';
import { AgentRuntime, type AgentRuntimeStatus } from '../../agent/AgentRuntime.js';
import {
  normalizeUiState,
  toMicaUiWorkingStatus,
  type TerminalAgentSessionManager,
} from '../../agents/terminalAgentSessions.js';
import type { SubagentTaskManager, SubagentTaskRecord } from '../../agents/SubagentTaskManager.js';
import { ToolLogController } from '../../runtime/ToolLogController.js';
import { applyStatus, syncModelDisplay } from '../../runtime/uiBridge.js';
import type { LocalRuntimeController } from './LocalRuntimeController.js';

const MAX_AGENT_TURN_LOG_ITEMS = 120;
const BACKGROUND_TASK_SYNC_INTERVAL_MS = 1000;
const BASH_NOTICE_OUTPUT_BYTES = 40_000;

export class MicaUiRuntimeBridge {
  private readonly toolLogs = new Map<AgentRuntime, ToolLogController>();
  private readonly disposers = new Map<AgentRuntime, () => void>();
  private readonly messageTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly messageTimerOwners = new Map<string, AgentRuntime>();
  private readonly preserveTurnUiOnConnecting = new Set<AgentRuntime>();
  private readonly bridgeDisposers: Array<Disposable | (() => void) | undefined> = [];
  private backgroundTaskSyncTimer: ReturnType<typeof setInterval> | null = null;
  private readonly bashTaskSessions = new Map<string, string>();
  private readonly bashShell = new ToolRunShell();

  constructor(
    private agent: AgentRuntime,
    private readonly runtime: LocalRuntimeController,
    private readonly agentSessions: TerminalAgentSessionManager,
    private readonly subagentTasks?: SubagentTaskManager,
  ) {}

  watchAgent(agent: AgentRuntime): void {
    this.attachAgentEvents(agent);
    this.syncAgentStatusItems();
  }

  switchAgent(agent: AgentRuntime): void {
    this.agent = agent;
    this.attachAgentEvents(agent);
    syncModelDisplay(agent);
    this.syncAgentStatusItems();
    this.syncSubagentTaskItems();
    this.syncBackgroundTaskItems();
  }

  start(): void {
    syncModelDisplay(this.agent);

    this.attachAgentEvents(this.agent);
    this.syncAgentStatusItems();
    this.syncSubagentTaskItems();
    this.startBackgroundTaskSync();

    if (this.subagentTasks) {
      this.bridgeDisposers.push(
        this.subagentTasks.subscribe((_task, owner) => {
          if (this.isActiveAgent(owner)) this.syncSubagentTaskItems();
        }),
      );
    }

    this.bridgeDisposers.push(
      this.runtime.events.on('event', (event) => {
        if (event.type === 'queue:changed') {
          const owner = eventOwnerAgent(event.owner, this.agent);
          const session = this.agentSessions.findByAgent(owner) ?? this.agentSessions.current();
          const pendingInputs = event.pendingInputs.map((input) => input.displayText ?? input.text);
          const pendingQueueMode = event.pendingInputs.at(-1)?.queueMode ?? null;
          session.uiState = normalizeUiState({ ...session.uiState, pendingInputs, pendingQueueMode });
          if (this.isActiveAgent(session.agent)) micaUi.conversation.setPendingInputs(pendingInputs, pendingQueueMode);
        }
        if (event.type === 'notification') {
          const owner = eventOwnerAgent(event.owner, this.agent);
          this.showNoticeForAgent(owner, event.message, event.level);
        }
        if (event.type === 'turn:started') {
          const owner = eventOwnerAgent(event.owner, this.agent);
          const session = this.agentSessions.findByAgent(owner) ?? this.agentSessions.current();
          const toolLogs = this.toolLogFor(session.agent);
          const preservePreviousTurnUi = event.preservePreviousTurnUi === true;
          if (preservePreviousTurnUi) {
            this.preserveTurnUiOnConnecting.add(session.agent);
          } else {
            this.preserveTurnUiOnConnecting.delete(session.agent);
          }
          toolLogs.resetTurn({ clearThinkingText: !preservePreviousTurnUi });
          session.uiState = normalizeUiState({
            ...session.uiState,
            agentTurnLogItems: preservePreviousTurnUi ? session.uiState.agentTurnLogItems : [],
            thinkingText: preservePreviousTurnUi ? session.uiState.thinkingText : '',
            lastTurnOutcome: 'running',
          });
          if (this.isActiveAgent(session.agent) && !preservePreviousTurnUi) {
            micaUi.panels.clearAgentTurnLogItems();
          }
        }
        if (event.type === 'turn:finished') {
          this.toolLogFor(eventOwnerAgent(event.owner, this.agent)).endThinkingSegment();
        }
        if (event.type === 'turn:aborted') {
          const owner = eventOwnerAgent(event.owner, this.agent);
          const session = this.agentSessions.findByAgent(owner) ?? this.agentSessions.current();
          const conversationMessages = session.uiState.conversationMessages.length
            ? session.uiState.conversationMessages
            : session.agent.toConversationMessages();
          session.uiState = normalizeUiState({
            ...session.uiState,
            conversationMessages,
            responseText: '',
            pendingInputs: [],
            pendingQueueMode: null,
            workingStatus: { type: 'idle' },
            lastTurnOutcome: 'aborted',
          });
          if (this.isActiveAgent(session.agent)) {
            micaUi.conversation.setMessages(session.uiState.conversationMessages);
            micaUi.conversation.clearResponseText();
            micaUi.conversation.clearPendingInput();
            micaUi.panels.status.idle();
          }
        }
      }),
    );

    this.bridgeDisposers.push(
      micaUi.terminalInput.onSubmit((text, options) => {
        if (options?.bashMode) {
          void this.runBashCommand(text.trim());
          return;
        }
        void this.runtime.submit(text, { queueMode: options?.queueMode, displayText: options?.displayText });
      }),
    );

    micaUi.panels.setOnAbortAgent(() => {
      void this.runtime.abort();
    });

    micaUi.panels.setOnEditPendingInput(() => this.runtime.editLastPendingInput());
  }

  clearToolLogs(): void {
    const session = this.agentSessions.current();
    session.uiState = normalizeUiState({
      ...session.uiState,
      agentTurnLogItems: [],
      thinkingText: '',
    });
    this.toolLogFor(this.agent).resetAll();
  }

  showMessageForAgent(agent: AgentRuntime, text: string, ttl = 3000): void {
    const session = this.sessionFor(agent);
    const id = `msg-${session.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    session.uiState = normalizeUiState({
      ...session.uiState,
      messageBarMessages: [...session.uiState.messageBarMessages, { id, text }],
    });
    if (this.isActiveAgent(agent)) {
      micaUi.messageBar.addMessage({ id, text });
    }
    const timer = setTimeout(() => {
      const currentSession = this.agentSessions.findByAgent(agent);
      if (currentSession) {
        currentSession.uiState = normalizeUiState({
          ...currentSession.uiState,
          messageBarMessages: currentSession.uiState.messageBarMessages.filter((message) => message.id !== id),
        });
      }
      if (this.isActiveAgent(agent)) micaUi.messageBar.removeMessage(id);
      this.messageTimers.delete(id);
      this.messageTimerOwners.delete(id);
    }, ttl);
    this.messageTimers.set(id, timer);
    this.messageTimerOwners.set(id, agent);
  }

  private showNoticeForAgent(agent: AgentRuntime, text: string, level: 'info' | 'warn' | 'error'): void {
    const session = this.sessionFor(agent);
    const status: 'success' | 'warning' | 'error' | 'info' =
      level === 'error' ? 'error' : level === 'warn' ? 'warning' : 'info';
    const message = { role: 'notice' as const, content: text, status };
    const messages = [...session.uiState.conversationMessages, message];
    session.uiState = normalizeUiState({ ...session.uiState, conversationMessages: messages });
    if (this.isActiveAgent(agent)) micaUi.conversation.setMessages(messages);
  }

  syncAgentStatusItems(): void {
    micaUi.panels.setAgentStatusItems(this.agentSessions.list());
  }

  syncBackgroundTaskItems(): void {
    const tasks = listBackgroundTasks({ status: 'all' });
    micaUi.panels.setBackgroundTaskItems(
      tasks
        .filter((task) => !task.agent_owner_id || task.agent_owner_id === this.agent.taskOwnerId)
        .map(toUiBackgroundTask),
    );
    this.syncBashNotices(tasks);
  }

  private async runBashCommand(command: string): Promise<void> {
    const session = this.agentSessions.current();
    if (!command) {
      this.upsertBashNotice(session.id, '命令不能为空。', '! bash', 'error');
      return;
    }
    const result = await this.bashShell.execute(
      { command, cwd: process.cwd(), run_in_background: true },
      { context: { agent: session.agent } },
    );
    const taskId = result.match(/id: ([a-f0-9]{12})/)?.[1];
    if (!taskId) {
      this.upsertBashNotice(session.id, `$ ${command}\n\n${result}`, `! ${command}`, 'error');
      return;
    }
    this.bashTaskSessions.set(taskId, session.id);
    this.upsertBashNotice(
      session.id,
      `$ ${command}\n\n命令正在后台执行（task ${taskId}）。`,
      bashNoticeCommand(command, taskId),
      'running',
    );
    this.syncBackgroundTaskItems();
  }

  private syncBashNotices(tasks: BackgroundTaskMeta[]): void {
    for (const task of tasks) {
      const sessionId = this.bashTaskSessions.get(task.id);
      if (!sessionId) continue;
      const isRunning = task.status === 'starting' || task.status === 'running';
      const session = this.agentSessions.findById(sessionId);
      const command = bashNoticeCommand(task.command, task.id);
      const alreadyFinalized = session?.uiState.conversationMessages.some(
        (item) => item.role === 'notice' && item.command === command && item.status !== 'running',
      );
      if (alreadyFinalized) {
        this.bashTaskSessions.delete(task.id);
        continue;
      }
      const output = readBackgroundTaskOutput(task, {
        maxBytes: BASH_NOTICE_OUTPUT_BYTES,
        tailBytes: BASH_NOTICE_OUTPUT_BYTES,
      }).content;
      const visibleOutput = cleanBackgroundTaskOutput(output);
      const status = isRunning
        ? 'running'
        : task.status === 'finished' && (task.exit_code ?? 0) === 0
          ? 'success'
          : task.status === 'killed'
            ? 'warning'
            : 'error';
      this.upsertBashNotice(
        sessionId,
        `$ ${task.command}\n\n${visibleOutput || (isRunning ? '等待输出…' : '(no output)')}`,
        command,
        status,
        !isRunning,
      );
      if (!isRunning) this.bashTaskSessions.delete(task.id);
    }
  }

  private upsertBashNotice(
    sessionId: string,
    content: string,
    command: string,
    status: 'running' | 'success' | 'warning' | 'error',
    save = true,
  ): void {
    const session = this.agentSessions.findById(sessionId);
    if (!session) return;
    const message = { role: 'notice' as const, content, command, status };
    const messages = [...session.uiState.conversationMessages];
    const runningIndex = messages.findLastIndex(
      (item) => item.role === 'notice' && item.command === command && item.status === 'running',
    );
    if (runningIndex >= 0) messages[runningIndex] = message;
    else messages.push(message);
    session.uiState = normalizeUiState({ ...session.uiState, conversationMessages: messages });
    if (this.agentSessions.current().id === sessionId) micaUi.conversation.setMessages(messages);
    if (save) session.sessionController.saveCurrent({ allowEmpty: true });
  }

  syncSubagentTaskItems(): void {
    micaUi.panels.setSubagentTaskItems(
      (this.subagentTasks?.list(this.agent) ?? []).filter((task) => task.status === 'running').map(toUiSubagentTask),
    );
  }

  stop(): void {
    for (const disposable of this.bridgeDisposers.splice(0)) {
      if (!disposable) continue;
      if (typeof disposable === 'function') {
        disposable();
      } else {
        void disposable.dispose();
      }
    }
    micaUi.panels.setOnAbortAgent(() => undefined);
    micaUi.panels.setOnEditPendingInput(() => null);
    if (this.backgroundTaskSyncTimer) {
      clearInterval(this.backgroundTaskSyncTimer);
      this.backgroundTaskSyncTimer = null;
    }
    for (const dispose of this.disposers.values()) dispose();
    for (const timer of this.messageTimers.values()) clearTimeout(timer);
    this.disposers.clear();
    this.toolLogs.clear();
    this.messageTimers.clear();
    this.messageTimerOwners.clear();
    this.preserveTurnUiOnConnecting.clear();
  }

  disposeAgent(agent: AgentRuntime): void {
    this.disposers.get(agent)?.();
    this.disposers.delete(agent);
    this.toolLogs.delete(agent);
    this.preserveTurnUiOnConnecting.delete(agent);
    for (const [id, owner] of this.messageTimerOwners) {
      if (owner !== agent) continue;
      const timer = this.messageTimers.get(id);
      if (timer) clearTimeout(timer);
      this.messageTimers.delete(id);
      this.messageTimerOwners.delete(id);
      if (this.isActiveAgent(agent)) micaUi.messageBar.removeMessage(id);
    }
  }

  private onText(agent: AgentRuntime, text: string): void {
    const session = this.sessionFor(agent);
    const toolLogs = this.toolLogFor(agent);
    toolLogs.endThinkingSegment();
    const responseText = this.runtime.appendResponseTextFor(agent, text);
    session.uiState.responseText = responseText;
    if (this.isActiveAgent(agent)) micaUi.conversation.setResponseText(responseText);
  }

  private onThinking(agent: AgentRuntime, text: string): void {
    this.toolLogFor(agent).appendThinking(text);
  }

  private onToolCall(agent: AgentRuntime, toolCall: Parameters<ToolLogController['addToolCall']>[0]): void {
    this.toolLogFor(agent).addToolCall(toolCall);
  }

  private onToolResult(agent: AgentRuntime, toolResult: Parameters<ToolLogController['completeToolCall']>[0]): void {
    this.toolLogFor(agent).completeToolCall(toolResult);
  }

  private onUsage(agent: AgentRuntime, usage: AgentUsageRecord): void {
    const session = this.sessionFor(agent);
    const cachedTokenRate = calculateCachedTokenRate(agent.getSnapshot().usageHistory);
    session.uiState.contextSize = usage.totalTokens;
    session.uiState.cachedTokenRate = cachedTokenRate;
    session.uiState = normalizeUiState(session.uiState);
    this.runtime.events.publish({
      type: 'context:changed',
      tokens: usage.totalTokens,
      windowSize: micaUi.panels.modelDisplay.contextWindowSize.get(),
      owner: agent,
    });
    if (this.isActiveAgent(agent)) {
      micaUi.panels.contextSize.set(usage.totalTokens);
      micaUi.panels.cachedTokenRate.set(cachedTokenRate);
    }
  }

  private attachAgentEvents(agent: AgentRuntime): void {
    if (this.disposers.has(agent)) return;
    const onStatus = (status: AgentRuntimeStatus) => this.onStatus(agent, status);
    const onText = (text: string) => this.onText(agent, text);
    const onThinking = (text: string) => this.onThinking(agent, text);
    const onToolCall = (toolCall: Parameters<ToolLogController['addToolCall']>[0]) => this.onToolCall(agent, toolCall);
    const onToolResult = (toolResult: Parameters<ToolLogController['completeToolCall']>[0]) =>
      this.onToolResult(agent, toolResult);
    const onUsage = (usage: AgentUsageRecord) => this.onUsage(agent, usage);
    agent.events.on('status', onStatus);
    agent.events.on('text', onText);
    agent.events.on('thinking', onThinking);
    agent.events.on('toolCall', onToolCall);
    agent.events.on('toolResult', onToolResult);
    agent.events.on('usage', onUsage);
    this.disposers.set(agent, () => {
      agent.events.off('status', onStatus);
      agent.events.off('text', onText);
      agent.events.off('thinking', onThinking);
      agent.events.off('toolCall', onToolCall);
      agent.events.off('toolResult', onToolResult);
      agent.events.off('usage', onUsage);
    });
  }

  private onStatus(agent: AgentRuntime, status: AgentRuntimeStatus): void {
    const session = this.sessionFor(agent);
    if (status.type === 'connecting') {
      const preservePreviousTurnUi = this.preserveTurnUiOnConnecting.has(agent);
      this.toolLogFor(agent).resetTurn({ clearThinkingText: !preservePreviousTurnUi });
      this.preserveTurnUiOnConnecting.delete(agent);
    }
    if (status.type === 'completed' || status.type === 'error' || status.type === 'idle') {
      this.toolLogFor(agent).endThinkingSegment();
    }
    session.uiState = normalizeUiState({ ...session.uiState, workingStatus: toMicaUiWorkingStatus(status) });
    this.syncAgentStatusItems();
    if (this.isActiveAgent(agent)) applyStatus(status);
  }

  private toolLogFor(agent: AgentRuntime): ToolLogController {
    let controller = this.toolLogs.get(agent);
    if (controller) return controller;
    controller = new ToolLogController({
      setThinkingText: (text) => {
        const session = this.sessionFor(agent);
        session.uiState.thinkingText = text;
        if (this.isActiveAgent(agent)) micaUi.panels.thinkingText.set(text);
      },
      appendAgentTurnLogItem: (item) => {
        const session = this.sessionFor(agent);
        session.uiState.agentTurnLogItems = [...session.uiState.agentTurnLogItems, item].slice(
          -MAX_AGENT_TURN_LOG_ITEMS,
        );
        if (this.isActiveAgent(agent)) micaUi.panels.appendAgentTurnLogItem(item);
      },
      replaceAgentTurnLogItem: (item) => {
        const session = this.sessionFor(agent);
        const items = session.uiState.agentTurnLogItems;
        const index = items.findIndex((existing) => existing.id === item.id);
        session.uiState.agentTurnLogItems = (
          index === -1 ? [...items, item] : [...items.slice(0, index), item, ...items.slice(index + 1)]
        ).slice(-MAX_AGENT_TURN_LOG_ITEMS);
        if (this.isActiveAgent(agent)) micaUi.panels.replaceAgentTurnLogItem(item);
      },
    });
    this.toolLogs.set(agent, controller);
    return controller;
  }

  private sessionFor(agent: AgentRuntime) {
    const session = this.agentSessions.findByAgent(agent);
    if (!session) throw new Error('Agent session is not registered');
    return session;
  }

  private isActiveAgent(agent: AgentRuntime): boolean {
    return this.agent === agent;
  }

  private startBackgroundTaskSync(): void {
    this.syncBackgroundTaskItems();
    if (this.backgroundTaskSyncTimer) return;
    this.backgroundTaskSyncTimer = setInterval(() => this.syncBackgroundTaskItems(), BACKGROUND_TASK_SYNC_INTERVAL_MS);
    this.backgroundTaskSyncTimer.unref?.();
  }
}

function bashNoticeCommand(command: string, taskId: string): string {
  return `! ${command} · ${taskId}`;
}

function toUiBackgroundTask(task: BackgroundTaskMeta): MicaUiBackgroundTaskItem {
  return {
    id: task.id,
    agentOwnerId: task.agent_owner_id,
    command: task.command,
    cwd: task.cwd,
    shell: task.shell,
    pid: task.pid,
    outputPath: task.output_path,
    outputSize: getBackgroundTaskOutputSize(task),
    status: task.status,
    startedAt: task.started_at,
    finishedAt: task.finished_at,
  };
}

function toUiSubagentTask(task: SubagentTaskRecord): MicaUiSubagentTaskItem {
  return {
    id: task.id,
    description: task.description,
    subagentType: task.subagent_type,
    model: task.model,
    status: task.status,
    ...(task.parent_task_id ? { parentTaskId: task.parent_task_id } : {}),
    activities: (task.activities ?? []).map((activity) => ({
      id: activity.id,
      summary: activity.summary,
      ...(activity.toolName ? { toolName: activity.toolName } : {}),
      startedAt: activity.startedAt,
    })),
    startedAt: task.started_at,
    finishedAt: task.finished_at,
  };
}

function eventOwnerAgent(owner: unknown, fallback: AgentRuntime): AgentRuntime {
  return owner instanceof AgentRuntime ? owner : fallback;
}

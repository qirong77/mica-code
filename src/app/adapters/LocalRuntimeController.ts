import type { AgentQueryContent } from '@packages/mica-agent/index.js';
import { micaAgent } from '@packages/mica-agent/index.js';
import { runtimeEnv } from '@packages/mica-config/runtimeEnv.js';
import { micaTools } from '@packages/mica-tools/index.js';
import { micaUi, type MicaUiConversationMessage } from '@packages/mica-ui/index.js';
import type { CommandRegistry } from '@packages/mica-commands/index.js';
import type { HookRegistry, ServiceContainer } from '@packages/mica-plugin/index.js';
import {
  micaRuntime,
  type AbortResult,
  type RuntimeController,
  type RuntimeInput,
  type RuntimeStatus,
  type RuntimeViewSnapshot,
  type RewindApplyResult,
  type RewindPreviewResult,
  type SubmitOptions,
  type SubmitResult,
} from '@packages/mica-runtime/index.js';
import type { RewindApplyRequest, RewindCheckpointSummary } from '@packages/mica-runtime/Rewind.js';
import { AgentAbortError, type AgentRuntime } from '../../agent/AgentRuntime.js';
import type { SessionController } from '../../session/SessionController.js';
import { getActiveContext } from '../activeContext.js';
import {
  normalizeUiState,
  type TerminalAgentSession,
  type TerminalAgentTurnOutcome,
} from '../../agents/terminalAgentSessions.js';
import { RewindCheckpointManager } from '../../runtime/RewindCheckpointManager.js';

const ALLOW_DURING_EXCLUSIVE_TASK_COMMANDS = new Set(['status', 'task', 'agents', 'new']);
const MAX_RESPONSE_BUFFER_CHARS = runtimeEnv.ui.responseTextMaxChars;
const RESPONSE_TRUNCATION_MARKER = '[response display truncated]\n';
const MAX_TURN_RETRIES = 5;
const TURN_RETRY_DELAY_MS = 10_000;
const RETRY_TURN_NOTICE_COMMAND = '/error';
const STOP_ABORT_WAIT_MS = 5000;

type RuntimeActiveContext = {
  agentSessions: {
    findByAgent(agent: AgentRuntime): TerminalAgentSession | undefined;
  };
  uiBridge?: {
    syncAgentStatusItems(): void;
  };
};

type RuntimeInputHookEvent = {
  runtime: LocalRuntimeController;
  input: RuntimeInput;
  isCommand: boolean;
  owner: AgentRuntime;
};

type MicaUiNoticeMessage = Extract<MicaUiConversationMessage, { role: 'notice' }>;

export class LocalRuntimeController implements RuntimeController {
  readonly events = new micaRuntime.RuntimeEventBus();
  readonly queue = {
    enqueue: (input: RuntimeInput) => this.queueFor(this.queueAgent()).enqueue(input),
    dequeue: () => this.queueFor(this.queueAgent()).dequeue(),
    dequeueByMode: (mode: RuntimeInput['queueMode']) => this.queueFor(this.queueAgent()).dequeueByMode(mode),
    clear: () => this.queueFor(this.queueAgent()).clear(),
    list: () => this.queueFor(this.queueAgent()).list(),
    count: () => this.queueFor(this.queueAgent()).count(),
  };
  private readonly runningAgents = new Set<AgentRuntime>();
  private readonly responseBuffers = new Map<AgentRuntime, string>();
  private readonly committedResponseBuffers = new Map<AgentRuntime, string>();
  private readonly queues = new Map<AgentRuntime, InstanceType<typeof micaRuntime.MessageQueueService>>();
  private readonly systemQueues = new Map<AgentRuntime, RuntimeInput[]>();
  private readonly sessionControllers = new Map<AgentRuntime, SessionController>();
  private readonly clearingAgents = new Set<AgentRuntime>();
  private readonly exclusiveTasks = new Map<AgentRuntime, { id: number; label: string }>();
  private readonly rewindCheckpoints = new RewindCheckpointManager();
  private readonly activeTurns = new Set<Promise<void>>();
  private hookAgent: AgentRuntime | null = null;
  private nextExclusiveTaskId = 1;
  private stopping = false;

  constructor(
    private agent: AgentRuntime,
    private sessionController: SessionController,
    private readonly commands: CommandRegistry,
    private readonly hooks: HookRegistry,
    private readonly services: ServiceContainer,
  ) {
    this.sessionControllers.set(agent, sessionController);
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.hooks.emit('runtime:start', { runtime: this });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const agent of this.runningAgents) {
      agent.abort();
    }
    if (this.activeTurns.size > 0) {
      await waitForActiveTurns(this.activeTurns, STOP_ABORT_WAIT_MS);
    }
    await this.hooks.emit('runtime:stop', { runtime: this });
    this.responseBuffers.clear();
    this.committedResponseBuffers.clear();
    this.queues.clear();
    this.systemQueues.clear();
    this.sessionControllers.clear();
    this.clearingAgents.clear();
    this.exclusiveTasks.clear();
  }

  disposeAgent(agent: AgentRuntime): void {
    this.responseBuffers.delete(agent);
    this.committedResponseBuffers.delete(agent);
    this.queues.delete(agent);
    this.systemQueues.delete(agent);
    this.sessionControllers.delete(agent);
    this.clearingAgents.delete(agent);
    this.exclusiveTasks.delete(agent);
    this.rewindCheckpoints.clear(agent);
    this.runningAgents.delete(agent);
  }

  getStatus(): RuntimeStatus {
    return { running: this.runningAgents.has(this.queueAgent()) };
  }

  getSnapshot(): RuntimeViewSnapshot {
    return {
      status: this.getStatus(),
      pendingInputs: this.queue.list(),
    };
  }

  appendResponseText(text: string): string {
    const next = appendBoundedText(
      this.responseBuffers.get(this.agent) ?? '',
      text,
      MAX_RESPONSE_BUFFER_CHARS,
      RESPONSE_TRUNCATION_MARKER,
    );
    this.responseBuffers.set(this.agent, next);
    return next;
  }

  appendResponseTextFor(agent: AgentRuntime, text: string): string {
    const next = appendBoundedText(
      this.responseBuffers.get(agent) ?? '',
      text,
      MAX_RESPONSE_BUFFER_CHARS,
      RESPONSE_TRUNCATION_MARKER,
    );
    this.responseBuffers.set(agent, next);
    return next;
  }

  getResponseBufferFor(agent: AgentRuntime): string {
    return this.responseBuffers.get(agent) ?? '';
  }

  clearResponseBuffer(): void {
    this.responseBuffers.set(this.agent, '');
  }

  clearResponseBufferFor(agent: AgentRuntime): void {
    this.responseBuffers.set(agent, '');
  }

  clear(): void {
    const isRunning = this.runningAgents.has(this.agent);
    this.responseBuffers.set(this.agent, '');
    this.rewindCheckpoints.clear(this.agent);
    if (isRunning) {
      this.clearingAgents.add(this.agent);
    } else {
      this.clearingAgents.delete(this.agent);
    }
    this.queue.clear();
    this.events.publish({ type: 'queue:changed', pendingInputs: this.queue.list(), owner: this.agent });
  }

  switchSession(agent: AgentRuntime, sessionController: SessionController): void {
    this.agent = agent;
    this.sessionController = sessionController;
    this.sessionControllers.set(agent, sessionController);
    this.events.publish({ type: 'queue:changed', pendingInputs: this.queue.list(), owner: agent });
  }

  getQueueOwner(): AgentRuntime {
    return this.queueAgent();
  }

  enqueueForAgent(agent: AgentRuntime, input: RuntimeInput): boolean {
    return this.queueFor(agent).enqueue(input);
  }

  dequeueForAgent(agent: AgentRuntime): RuntimeInput | null {
    return this.queueFor(agent).dequeue();
  }

  listQueueForAgent(agent: AgentRuntime): RuntimeInput[] {
    return this.queueFor(agent).list();
  }

  countQueueForAgent(agent: AgentRuntime): number {
    return this.queueFor(agent).count();
  }

  deliverSystemInput(agent: AgentRuntime, text: string, displayMessage: string): void {
    if (this.stopping) return;
    if (!this.sessionControllerFor(agent)) return;
    const input = micaRuntime.createRuntimeInput(text, 'system');
    const queue = this.systemQueues.get(agent) ?? [];
    queue.push(input);
    this.systemQueues.set(agent, queue);
    this.events.publish({ type: 'notification', level: 'info', message: displayMessage, owner: agent, ttl: 6000 });
  }

  isAgentBusy(agent = this.agent): boolean {
    return this.runningAgents.has(agent) || this.exclusiveTasks.has(agent);
  }

  getExclusiveTask(agent = this.agent): { label: string } | null {
    return this.exclusiveTasks.get(agent) ?? null;
  }

  beginExclusiveTask(agent: AgentRuntime, label: string): () => void {
    if (this.runningAgents.has(agent)) {
      throw new Error('Agent is running; wait or abort before starting another task');
    }
    const existing = this.exclusiveTasks.get(agent);
    if (existing) {
      throw new Error(`${existing.label} is already running`);
    }
    const id = this.nextExclusiveTaskId++;
    this.exclusiveTasks.set(agent, { id, label });
    return () => {
      const current = this.exclusiveTasks.get(agent);
      if (current?.id !== id) return;
      this.exclusiveTasks.delete(agent);
    };
  }

  editLastPendingInput(): string | null {
    const owner = this.queueAgent();
    const input = this.queueFor(owner).removeLast();
    this.events.publish({ type: 'queue:changed', pendingInputs: this.queueFor(owner).list(), owner });
    return input?.text ?? null;
  }

  listRewindCheckpoints(): RewindCheckpointSummary[] {
    return this.rewindCheckpoints.list(this.agent);
  }

  getRewindPreview(id?: string): RewindPreviewResult {
    return this.rewindCheckpoints.preview(this.agent, id);
  }

  clearRewindCheckpoints(): void {
    this.rewindCheckpoints.clear(this.agent);
  }

  applyRewind(request: RewindApplyRequest): RewindApplyResult {
    const result = this.rewindCheckpoints.apply(this.agent, request);
    this.responseBuffers.set(this.agent, '');
    this.queue.clear();
    this.events.publish({ type: 'queue:changed', pendingInputs: this.queue.list(), owner: this.agent });
    return result;
  }

  async submit(rawText: string, options: SubmitOptions = {}): Promise<SubmitResult> {
    const text = rawText.trim();
    if (!text) return { ok: false, reason: 'empty' };

    const parsedCommand = this.commands.resolve(text);
    if (parsedCommand) {
      const activeTask = this.exclusiveTasks.get(this.agent);
      if (activeTask && !ALLOW_DURING_EXCLUSIVE_TASK_COMMANDS.has(parsedCommand.command.name)) {
        this.events.publish({
          type: 'notification',
          level: 'warn',
          message: `${activeTask.label} 正在执行，完成后再执行该命令`,
          owner: this.agent,
        });
        return { ok: false, reason: 'busy' };
      }
      if (this.runningAgents.has(this.agent) && parsedCommand.command.allowDuringTurn !== true) {
        this.events.publish({
          type: 'notification',
          level: 'warn',
          message: '当前任务运行中，稍后再执行该命令',
          owner: this.agent,
        });
        return { ok: false, reason: 'busy' };
      }

      await this.hooks.emit('command:before', {
        runtime: this,
        command: parsedCommand.command,
        args: parsedCommand.args,
      });
      const result = await this.commands.execute(text, { runtime: this, services: this.services });
      await this.hooks.emit('command:after', {
        runtime: this,
        command: parsedCommand.command,
        args: parsedCommand.args,
        result,
      });
      if (!result.ok) {
        this.events.publish({
          type: 'notification',
          level: 'error',
          message: result.error instanceof Error ? result.error.message : String(result.error),
          owner: this.agent,
        });
        return { ok: false, reason: 'command_failed', error: result.error };
      }
      return { ok: true, handled: true };
    }

    const targetAgent = this.submissionAgent(options);
    const targetSessionController = this.sessionControllers.get(targetAgent) ?? this.sessionController;
    return this.submitInputToAgent(text, targetAgent, targetSessionController, options);
  }

  async submitToAgent(
    agent: AgentRuntime,
    sessionController: SessionController,
    rawText: string,
    options: SubmitOptions = {},
  ): Promise<SubmitResult> {
    const text = rawText.trim();
    if (!text) return { ok: false, reason: 'empty' };
    this.sessionControllers.set(agent, sessionController);
    return this.submitInputToAgent(text, agent, sessionController, options);
  }

  private async submitInputToAgent(
    text: string,
    targetAgent: AgentRuntime,
    targetSessionController: SessionController,
    options: SubmitOptions,
  ): Promise<SubmitResult> {
    const input = micaRuntime.createRuntimeInput(text, options.source ?? 'ui', {
      queueMode: options.queueMode,
      displayText: options.displayText,
    });
    const activeTask = this.exclusiveTasks.get(targetAgent);
    if (activeTask) {
      this.events.publish({
        type: 'notification',
        level: 'warn',
        message: `${activeTask.label} 正在执行，完成后再发送对话`,
        owner: targetAgent,
      });
      return { ok: false, reason: 'busy' };
    }

    const inputHook = await this.hooks.guard<RuntimeInputHookEvent>('input:received', {
      runtime: this,
      input,
      isCommand: false,
      owner: targetAgent,
    });

    if (inputHook.blocked) {
      return { ok: false, reason: 'busy' };
    }
    if (inputHook.handled) {
      return { ok: true, handled: true, queued: inputHook.reason === 'queued' };
    }

    if (this.runningAgents.has(targetAgent)) {
      this.events.publish({
        type: 'notification',
        level: 'warn',
        message: '当前任务运行中',
        owner: targetAgent,
      });
      return { ok: false, reason: 'busy' };
    }

    await this.trackTurn(this.runTurn(inputHook.event.input, targetAgent, targetSessionController));
    return { ok: true };
  }

  private async trackTurn(turn: Promise<void>): Promise<void> {
    this.activeTurns.add(turn);
    try {
      await turn;
    } finally {
      this.activeTurns.delete(turn);
    }
  }

  async abort(): Promise<AbortResult> {
    if (!this.runningAgents.has(this.agent)) return { ok: false, reason: 'not_running' };
    try {
      this.agent.abort();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: 'error', error };
    }
  }

  private async runTurn(input: RuntimeInput, agent: AgentRuntime, sessionController: SessionController): Promise<void> {
    this.runningAgents.add(agent);
    const reservedRunId = agent.reserveRunId();
    const startedAt = Date.now();
    const initialSystemInputs = input.source === 'system' ? [] : this.takeAllSystemInputs(agent);
    const inputContent =
      input.source === 'system' ? input.text : ((await micaUi.parseImageRefs(input.text)) as AgentQueryContent);
    const content = appendSystemInputs(inputContent, initialSystemInputs);
    const displayedUserContent = input.source === 'system' ? content : inputContent;
    const displayContent = await parseDisplayContent(input, inputContent);
    if (!agent.isCurrent(reservedRunId)) {
      this.prependSystemInputs(agent, initialSystemInputs);
      this.runningAgents.delete(agent);
      if (this.isActiveAgent(agent)) this.events.publish({ type: 'turn:aborted', input, owner: agent });
      return;
    }
    let runId: number | null = null;
    let hasError = false;
    let wasAborted = false;
    let rewindCheckpointId: string | null = null;
    // Capture pre-turn client state so we can restore it before each retry.
    const preTurnSnapshot = agent.captureClientSnapshot();
    let hadNonRetryableToolCall = false;
    const markToolCall = (toolCall: { name: string }) => {
      if (!micaTools.isReadOnly(toolCall.name)) {
        hadNonRetryableToolCall = true;
      }
    };
    agent.events.on('toolCall', markToolCall);

    this.responseBuffers.set(agent, '');
    this.committedResponseBuffers.set(agent, '');
    const activeContext = getActiveContext<RuntimeActiveContext>();
    const session = activeContext?.agentSessions.findByAgent(agent);
    const clearPreviousTurnUi = shouldClearPreviousTurnUi(session?.uiState.lastTurnOutcome);
    const previousConversationMessages = displayConversationMessages(session, agent);
    if (input.source !== 'system') {
      rewindCheckpointId = this.rewindCheckpoints.capture(agent, input, previousConversationMessages);
    }
    if (session) {
      session.uiState = normalizeUiState({
        ...session.uiState,
        conversationMessages:
          input.source === 'system'
            ? previousConversationMessages
            : [...previousConversationMessages, { role: 'user', content: displayedUserContent, displayContent }],
        responseText: '',
        pendingInputs: [],
        pendingQueueMode: null,
        agentTurnLogItems: clearPreviousTurnUi ? [] : session.uiState.agentTurnLogItems,
        thinkingText: clearPreviousTurnUi ? '' : session.uiState.thinkingText,
        workingStatus: { type: 'connecting' },
        lastTurnOutcome: 'running',
      });
      activeContext?.uiBridge?.syncAgentStatusItems();
    }
    if (this.isActiveAgent(agent)) {
      this.events.publish({ type: 'turn:started', input, owner: agent, preservePreviousTurnUi: !clearPreviousTurnUi });
      if (input.source !== 'system') micaUi.terminalInput.clearText();
      if (session) {
        micaUi.conversation.setMessages(session.uiState.conversationMessages);
      } else if (input.source !== 'system') {
        micaUi.conversation.appendUserMessage(displayContent ?? displayedUserContent);
      }
      micaUi.conversation.clearResponseText();
      if (clearPreviousTurnUi) {
        micaUi.panels.clearAgentTurnLogItems();
      }
      micaUi.panels.status.connecting();
    }

    try {
      sessionController.saveCurrent({ allowEmpty: true, turnState: 'running' });
      await this.hooks.emit('turn:before', { runtime: this, input, content });
      await this.hooks.pipeline('prompt:build', { runtime: this, input, content });

      let pendingRetryNotice: { error: unknown; index: number; retryAttempt: number } | null = null;
      for (let attempt = 0; attempt <= MAX_TURN_RETRIES; attempt++) {
        const attemptSystemInputs: RuntimeInput[] = [];
        if (attempt > 0) {
          // Restore client state to before the turn, clearing any partial tool results.
          if (preTurnSnapshot) {
            agent.restoreClientSnapshot(preTurnSnapshot);
          }
          this.responseBuffers.set(agent, '');
          this.committedResponseBuffers.set(agent, '');
          sessionController.saveCurrent({ allowEmpty: true, turnState: 'running' });

          if (this.isActiveAgent(agent)) {
            micaUi.conversation.clearResponseText();
            micaUi.panels.thinkingText.set('');
            micaUi.panels.status.connecting();
          }

          await waitForRetryDelay(agent, TURN_RETRY_DELAY_MS, (remainingMs) => {
            if (!pendingRetryNotice) return;
            updateRetryNoticeMessage(
              session,
              pendingRetryNotice.index,
              createRetryNoticeMessage(pendingRetryNotice.error, pendingRetryNotice.retryAttempt, remainingMs),
              this.isActiveAgent(agent),
            );
          });
          if (pendingRetryNotice) {
            updateRetryNoticeMessage(
              session,
              pendingRetryNotice.index,
              createRetryNoticeMessage(pendingRetryNotice.error, pendingRetryNotice.retryAttempt, null),
              this.isActiveAgent(agent),
            );
            pendingRetryNotice = null;
          }
        }

        try {
          const result = await agent.run(content, {
            reservedRunId: attempt === 0 ? reservedRunId : undefined,
            onIterationComplete: () => {
              this.saveIterationCheckpoint(agent, sessionController);
              return this.takeQueuedIterationInput(agent, attemptSystemInputs);
            },
          });
          runId = result.runId;
          const finalText = result.text;
          if (!agent.isCurrent(runId)) {
            this.prependSystemInputs(agent, initialSystemInputs);
            this.prependSystemInputs(agent, attemptSystemInputs);
            return;
          }

          const responseBuffer = this.responseBuffers.get(agent) ?? '';
          this.committedResponseBuffers.set(agent, '');
          this.responseBuffers.set(agent, '');
          const assistantMessage = createAssistantTextMessage(responseBuffer || finalText || '(empty response)');
          if (session) {
            session.uiState = normalizeUiState({
              ...session.uiState,
              conversationMessages: [...session.uiState.conversationMessages, assistantMessage],
              responseText: '',
            });
          }
          if (this.isActiveAgent(agent)) {
            if (session) {
              micaUi.conversation.setMessages(session.uiState.conversationMessages);
            } else {
              micaUi.conversation.appendAssistantMessage(assistantMessage.content);
            }
            micaUi.conversation.clearResponseText();
          }

          await this.hooks.emit('turn:beforePersist', { runtime: this, input, content, result });
          sessionController.saveCurrent({ turnState: 'completed' });
          return;
        } catch (error) {
          this.prependSystemInputs(agent, attemptSystemInputs);
          if (error instanceof AgentAbortError) {
            throw error;
          }
          if (hadNonRetryableToolCall || !micaAgent.isRetryableError(error) || attempt >= MAX_TURN_RETRIES) {
            throw error;
          }
          const retryNotice = createRetryNoticeMessage(error, attempt + 1, TURN_RETRY_DELAY_MS);
          let retryNoticeIndex = -1;
          if (session) {
            session.uiState = normalizeUiState({
              ...session.uiState,
              conversationMessages: [...session.uiState.conversationMessages, retryNotice],
            });
            retryNoticeIndex = session.uiState.conversationMessages.length - 1;
          }
          if (this.isActiveAgent(agent)) {
            if (session) {
              micaUi.conversation.setMessages(session.uiState.conversationMessages);
            } else {
              micaUi.conversation.appendNoticeMessage(retryNotice.content, {
                variant: retryNotice.variant,
                command: retryNotice.command,
              });
            }
          }
          if (retryNoticeIndex >= 0) {
            pendingRetryNotice = { error, index: retryNoticeIndex, retryAttempt: attempt + 1 };
          }
          await this.hooks.emit('turn:error', { runtime: this, input, content, error });
        }
      }
    } catch (error) {
      if (error instanceof AgentAbortError) {
        this.prependSystemInputs(agent, initialSystemInputs);
        wasAborted = true;
        runId = error.runId;
        const responseBuffer = this.responseBuffers.get(agent) ?? '';
        const responseForHistory = uncommittedResponseText(
          responseBuffer,
          this.committedResponseBuffers.get(agent) ?? '',
        );
        this.responseBuffers.set(agent, '');
        this.committedResponseBuffers.set(agent, '');
        if (!this.clearingAgents.has(agent)) {
          agent.preserveAbortedTurn(displayedUserContent, responseForHistory);
        }
        if (session && !this.clearingAgents.has(agent)) {
          const conversationMessages = appendAssistantResponseForDisplay(
            displayConversationMessages(session, agent),
            responseBuffer,
          );
          session.uiState = normalizeUiState({
            ...session.uiState,
            conversationMessages,
            responseText: '',
            workingStatus: { type: 'idle' },
            lastTurnOutcome: 'aborted',
          });
        }
        await this.hooks.emit('turn:abort', { runtime: this, input, content, error });
        if (!this.clearingAgents.has(agent)) sessionController.saveCurrent({ turnState: 'aborted' });
        if (this.isActiveAgent(agent)) {
          micaUi.panels.status.idle();
          this.events.publish({ type: 'turn:aborted', input, owner: agent });
        }
        return;
      }

      hasError = true;
      this.prependSystemInputs(agent, initialSystemInputs);
      await this.hooks.emit('turn:error', { runtime: this, input, content, error });
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorNotice = createFinalErrorNoticeMessage(errorMessage);
      if (session) {
        session.uiState = normalizeUiState({
          ...session.uiState,
          conversationMessages: [...session.uiState.conversationMessages, errorNotice],
          responseText: '',
          thinkingText: '',
          workingStatus: { type: 'idle' },
          lastTurnOutcome: 'error',
        });
      }
      if (this.isActiveAgent(agent)) {
        this.events.publish({ type: 'turn:error', input, error, owner: agent });
        if (session) {
          micaUi.conversation.setMessages(session.uiState.conversationMessages);
        } else {
          micaUi.conversation.appendNoticeMessage(errorNotice.content, {
            variant: errorNotice.variant,
            command: errorNotice.command,
          });
        }
        micaUi.conversation.clearResponseText();
        micaUi.panels.thinkingText.set('');
        micaUi.panels.status.idle();
      }
      sessionController.saveCurrent({ turnState: 'error' });
    } finally {
      agent.events.off('toolCall', markToolCall);
      this.runningAgents.delete(agent);
      this.clearingAgents.delete(agent);
      this.committedResponseBuffers.delete(agent);
      if (!hasError && !wasAborted) {
        if (session) {
          session.uiState = normalizeUiState({
            ...session.uiState,
            agentTurnLogItems: [],
            thinkingText: '',
            lastTurnOutcome: 'completed',
          });
        }
        if (this.isActiveAgent(agent)) {
          micaUi.panels.clearAgentTurnLogItems();
          micaUi.panels.thinkingText.set('');
        }
      }
      if (rewindCheckpointId) {
        this.rewindCheckpoints.finalize(agent, rewindCheckpointId, displayConversationMessages(session, agent));
      }
      const elapsedMs = Date.now() - startedAt;
      if (this.isActiveAgent(agent)) this.events.publish({ type: 'turn:finished', input, elapsedMs, owner: agent });
      this.hookAgent = agent;
      try {
        await this.hooks.emit('turn:after', { runtime: this, input, elapsedMs, hasError });
      } finally {
        this.hookAgent = null;
      }
    }
  }

  private async takeQueuedIterationInput(
    agent: AgentRuntime,
    consumedSystemInputs: RuntimeInput[],
  ): Promise<AgentQueryContent | null> {
    const queue = this.queueFor(agent);
    this.committedResponseBuffers.set(agent, this.responseBuffers.get(agent) ?? '');
    const systemQueue = this.systemQueues.get(agent);
    const systemInput = systemQueue?.shift() ?? null;
    if (systemQueue?.length === 0) this.systemQueues.delete(agent);
    if (systemInput) consumedSystemInputs.push(systemInput);
    const next = systemInput ?? queue.dequeueByMode('after_iteration');
    if (!systemInput) this.events.publish({ type: 'queue:changed', pendingInputs: queue.list(), owner: agent });
    if (!next) return null;

    const responseBuffer = this.responseBuffers.get(agent) ?? '';
    if (responseBuffer) {
      const session = getActiveContext<RuntimeActiveContext>()?.agentSessions.findByAgent(agent);
      if (session) {
        session.uiState = normalizeUiState({
          ...session.uiState,
          conversationMessages: appendAssistantResponseForDisplay(session.uiState.conversationMessages, responseBuffer),
          responseText: '',
        });
      }
      this.responseBuffers.set(agent, '');
      this.committedResponseBuffers.set(agent, '');
      if (this.isActiveAgent(agent)) {
        if (session) {
          micaUi.conversation.setMessages(session.uiState.conversationMessages);
        } else {
          micaUi.conversation.appendAssistantMessage([{ type: 'text', text: responseBuffer }]);
        }
        micaUi.conversation.clearResponseText();
      }
    }

    const content =
      next.source === 'system' ? next.text : ((await micaUi.parseImageRefs(next.text)) as AgentQueryContent);
    const displayContent = await parseDisplayContent(next, content);
    const session = getActiveContext<RuntimeActiveContext>()?.agentSessions.findByAgent(agent);
    if (session && next.source !== 'system') {
      session.uiState = normalizeUiState({
        ...session.uiState,
        conversationMessages: [...session.uiState.conversationMessages, { role: 'user', content, displayContent }],
      });
    }
    if (this.isActiveAgent(agent) && next.source !== 'system') {
      if (session) {
        micaUi.conversation.setMessages(session.uiState.conversationMessages);
      } else {
        micaUi.conversation.appendUserMessage(displayContent ?? content);
      }
      micaUi.conversation.clearResponseText();
    }
    return content;
  }

  private saveIterationCheckpoint(agent: AgentRuntime, sessionController: SessionController): void {
    const session = getActiveContext<RuntimeActiveContext>()?.agentSessions.findByAgent(agent);
    const responseBuffer = this.responseBuffers.get(agent) ?? '';
    if (!session || !responseBuffer.trim()) {
      sessionController.saveCurrent({ turnState: 'running' });
      return;
    }

    const previousUiState = session.uiState;
    session.uiState = normalizeUiState({
      ...previousUiState,
      conversationMessages: appendAssistantResponseForDisplay(previousUiState.conversationMessages, responseBuffer),
      responseText: '',
    });
    try {
      sessionController.saveCurrent({ turnState: 'running' });
    } finally {
      session.uiState = previousUiState;
    }
  }

  private isActiveAgent(agent: AgentRuntime): boolean {
    return this.agent === agent;
  }

  private queueAgent(): AgentRuntime {
    return this.hookAgent ?? this.agent;
  }

  private submissionAgent(options: SubmitOptions): AgentRuntime {
    return options.source === 'plugin' && this.hookAgent ? this.hookAgent : this.agent;
  }

  private queueFor(agent: AgentRuntime): InstanceType<typeof micaRuntime.MessageQueueService> {
    let queue = this.queues.get(agent);
    if (!queue) {
      queue = new micaRuntime.MessageQueueService();
      this.queues.set(agent, queue);
    }
    return queue;
  }

  private sessionControllerFor(agent: AgentRuntime): SessionController | undefined {
    const existing = this.sessionControllers.get(agent);
    if (existing) return existing;
    const session = getActiveContext<RuntimeActiveContext>()?.agentSessions.findByAgent(agent);
    if (!session) return undefined;
    this.sessionControllers.set(agent, session.sessionController);
    return session.sessionController;
  }

  private takeAllSystemInputs(agent: AgentRuntime): RuntimeInput[] {
    const inputs = this.systemQueues.get(agent) ?? [];
    this.systemQueues.delete(agent);
    return inputs;
  }

  private prependSystemInputs(agent: AgentRuntime, inputs: RuntimeInput[]): void {
    if (inputs.length === 0) return;
    this.systemQueues.set(agent, [...inputs, ...(this.systemQueues.get(agent) ?? [])]);
  }
}

function appendSystemInputs(content: AgentQueryContent, inputs: RuntimeInput[]): AgentQueryContent {
  if (inputs.length === 0) return content;
  const notifications = inputs.map((input) => input.text).join('\n\n');
  if (typeof content === 'string') return `${notifications}\n\n${content}`;
  return [{ type: 'text', text: notifications }, ...content];
}

function shouldClearPreviousTurnUi(outcome: TerminalAgentTurnOutcome | undefined): boolean {
  return outcome === undefined || outcome === 'idle' || outcome === 'completed' || outcome === 'error';
}

function displayConversationMessages(
  session: TerminalAgentSession | undefined,
  agent: AgentRuntime,
): ReturnType<AgentRuntime['toConversationMessages']> {
  return session?.uiState.conversationMessages.length
    ? session.uiState.conversationMessages
    : agent.toConversationMessages();
}

async function parseDisplayContent(
  input: RuntimeInput,
  parsedInputContent: AgentQueryContent,
): Promise<AgentQueryContent | undefined> {
  if (!input.displayText) return undefined;
  if (input.displayText === input.text) return parsedInputContent;
  return (await micaUi.parseImageRefs(input.displayText)) as AgentQueryContent;
}

function createRetryNoticeMessage(
  error: unknown,
  retryAttempt: number,
  remainingMs: number | null,
): MicaUiNoticeMessage {
  return {
    role: 'notice',
    content: formatRetryNoticeContent(error, retryAttempt, remainingMs),
    variant: 'error',
    command: RETRY_TURN_NOTICE_COMMAND,
  };
}

function createFinalErrorNoticeMessage(errorMessage: string): MicaUiNoticeMessage {
  return {
    role: 'notice',
    content: `请求失败: ${errorMessage}`,
    variant: 'error',
    command: RETRY_TURN_NOTICE_COMMAND,
  };
}

function formatRetryNoticeContent(error: unknown, retryAttempt: number, remainingMs: number | null): string {
  const retryLabel = `第 ${retryAttempt}/${MAX_TURN_RETRIES} 次重试`;
  const errorMessage = error instanceof Error ? error.message : String(error);

  if (remainingMs === null) {
    return [`请求暂时失败，已发起${retryLabel}。`, `错误：${errorMessage}`].join('\n');
  }

  const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  return [
    `请求暂时失败，将自动重试。`,
    `倒计时：${remainingSeconds}s 后发起${retryLabel}`,
    `错误：${errorMessage}`,
  ].join('\n');
}

function updateRetryNoticeMessage(
  session: TerminalAgentSession | undefined,
  index: number,
  notice: MicaUiNoticeMessage,
  isActive: boolean,
): void {
  if (!session || index < 0 || session.uiState.conversationMessages[index]?.role !== 'notice') return;
  session.uiState = normalizeUiState({
    ...session.uiState,
    conversationMessages: [
      ...session.uiState.conversationMessages.slice(0, index),
      notice,
      ...session.uiState.conversationMessages.slice(index + 1),
    ],
  });
  if (isActive) micaUi.conversation.setMessages(session.uiState.conversationMessages);
}

function waitForRetryDelay(
  agent: AgentRuntime,
  delayMs: number,
  onRemainingMs?: (remainingMs: number) => void,
): Promise<void> {
  const delayRunId = agent.activeRunId;
  const startedAt = Date.now();
  let lastRemainingSeconds = Math.ceil(delayMs / 1000);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      fn();
    };
    const updateCountdown = () => {
      const remainingMs = Math.max(0, delayMs - (Date.now() - startedAt));
      const remainingSeconds = Math.ceil(remainingMs / 1000);
      if (remainingSeconds === lastRemainingSeconds) return;
      lastRemainingSeconds = remainingSeconds;
      onRemainingMs?.(remainingMs);
    };
    const timer = setTimeout(() => finish(resolve), delayMs);
    const poll = setInterval(() => {
      if (agent.activeRunId !== delayRunId) {
        finish(() => reject(new AgentAbortError(agent.activeRunId)));
        return;
      }
      updateCountdown();
    }, 250);
  });
}

function createAssistantTextMessage(text: string): ReturnType<AgentRuntime['toConversationMessages']>[number] {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function appendAssistantResponseForDisplay(
  messages: ReturnType<AgentRuntime['toConversationMessages']>,
  responseText: string,
): ReturnType<AgentRuntime['toConversationMessages']> {
  const text = responseText.trim();
  if (!text) return messages;
  return [...messages, createAssistantTextMessage(responseText)];
}

function uncommittedResponseText(responseText: string, committedResponseText: string): string {
  if (!committedResponseText) return responseText;
  if (responseText.startsWith(committedResponseText)) {
    return responseText.slice(committedResponseText.length);
  }
  return responseText;
}

function appendBoundedText(previous: string, chunk: string, maxChars: number, marker: string): string {
  const next = `${previous}${chunk}`;
  if (next.length <= maxChars) return next;
  const body = next.startsWith(marker) ? next.slice(marker.length) : next;
  return `${marker}${body.slice(-(maxChars - marker.length))}`;
}

async function waitForActiveTurns(activeTurns: Set<Promise<void>>, timeoutMs: number): Promise<void> {
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  await Promise.race([Promise.allSettled([...activeTurns]).then(() => undefined), timeout]);
}

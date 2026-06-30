import type { AgentQueryContent } from '@packages/mica-agent/index.js';
import { micaAgent } from '@packages/mica-agent/index.js';
import { runtimeEnv } from '@packages/mica-config/runtimeEnv.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
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
import { AgentAbortError, type AgentRuntime } from '../../agent/AgentRuntime.js';
import type { SessionController } from '../../session/SessionController.js';
import { getActiveContext } from '../activeContext.js';
import {
  normalizeUiState,
  type TerminalAgentSession,
  type TerminalAgentTurnOutcome,
} from '../../agents/terminalAgentSessions.js';
import { RewindCheckpointManager } from '../../runtime/RewindCheckpointManager.js';

const ALLOW_DURING_EXCLUSIVE_TASK_COMMANDS = new Set(['log', 'status', 'agents', 'new']);
const MAX_RESPONSE_BUFFER_CHARS = runtimeEnv.ui.responseTextMaxChars;
const RESPONSE_TRUNCATION_MARKER = '[response display truncated]\n';
const MAX_TURN_RETRIES = 2;
const TURN_RETRY_DELAY_MS = 5000;

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
  private readonly queues = new Map<AgentRuntime, InstanceType<typeof micaRuntime.MessageQueueService>>();
  private readonly sessionControllers = new Map<AgentRuntime, SessionController>();
  private readonly clearingAgents = new Set<AgentRuntime>();
  private readonly exclusiveTasks = new Map<AgentRuntime, { id: number; label: string }>();
  private readonly rewindCheckpoints = new RewindCheckpointManager();
  private hookAgent: AgentRuntime | null = null;
  private nextExclusiveTaskId = 1;

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
    await this.hooks.emit('runtime:start', { runtime: this });
  }

  async stop(): Promise<void> {
    await this.hooks.emit('runtime:stop', { runtime: this });
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
      if (current?.id === id) this.exclusiveTasks.delete(agent);
    };
  }

  editLastPendingInput(): string | null {
    const owner = this.queueAgent();
    const input = this.queueFor(owner).removeLast();
    this.events.publish({ type: 'queue:changed', pendingInputs: this.queueFor(owner).list(), owner });
    return input?.text ?? null;
  }

  getRewindPreview(): RewindPreviewResult {
    return this.rewindCheckpoints.preview(this.agent);
  }

  applyRewind(id: string): RewindApplyResult {
    const result = this.rewindCheckpoints.apply(this.agent, id);
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
    const input = micaRuntime.createRuntimeInput(text, options.source ?? 'ui', { queueMode: options.queueMode });
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

    micaLogger.logRuntime('runtime', 'submit', { chars: text.length, running: this.runningAgents.has(targetAgent) });

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

    await this.runTurn(inputHook.event.input, targetAgent, targetSessionController);
    return { ok: true };
  }

  async abort(): Promise<AbortResult> {
    if (!this.runningAgents.has(this.agent)) return { ok: false, reason: 'not_running' };
    try {
      micaLogger.logRuntime('runtime', 'abort:requested', undefined, 'warn');
      this.agent.abort();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: 'error', error };
    }
  }

  private async runTurn(input: RuntimeInput, agent: AgentRuntime, sessionController: SessionController): Promise<void> {
    this.runningAgents.add(agent);
    const startedAt = Date.now();
    const content = micaUi.parseImageRefs(input.text) as AgentQueryContent;
    let runId: number | null = null;
    let hasError = false;
    let wasAborted = false;

    micaLogger.logRuntime('runtime', 'turn:start', { chars: input.text.length });
    this.rewindCheckpoints.capture(agent, input);

    // Capture pre-turn client state so we can restore it before each retry.
    const preTurnSnapshot = agent.captureClientSnapshot();
    let hadToolCall = false;
    const markToolCall = () => {
      hadToolCall = true;
    };
    agent.events.on('toolCall', markToolCall);

    this.responseBuffers.set(agent, '');
    const activeContext = getActiveContext<RuntimeActiveContext>();
    const session = activeContext?.agentSessions.findByAgent(agent);
    const clearPreviousTurnUi = shouldClearPreviousTurnUi(session?.uiState.lastTurnOutcome);
    if (session) {
      session.uiState = normalizeUiState({
        ...session.uiState,
        conversationMessages: [...agent.toConversationMessages(), { role: 'user', content }],
        responseText: '',
        pendingInputs: [],
        pendingQueueMode: null,
        logEntries: clearPreviousTurnUi ? [] : session.uiState.logEntries,
        agentTurnLogItems: clearPreviousTurnUi ? [] : session.uiState.agentTurnLogItems,
        thinkingText: clearPreviousTurnUi ? '' : session.uiState.thinkingText,
        workingStatus: { type: 'connecting' },
        lastTurnOutcome: 'running',
      });
      activeContext?.uiBridge?.syncAgentStatusItems();
    }
    if (this.isActiveAgent(agent)) {
      this.events.publish({ type: 'turn:started', input, owner: agent, preservePreviousTurnUi: !clearPreviousTurnUi });
      micaUi.terminalInput.clearText();
      micaUi.conversation.appendUserMessage(content);
      micaUi.conversation.clearResponseText();
      if (clearPreviousTurnUi) {
        micaUi.panels.clearLogEntries();
        micaUi.panels.clearAgentTurnLogItems();
      }
      micaUi.panels.status.connecting();
    }

    try {
      await this.hooks.emit('turn:before', { runtime: this, input, content });
      await this.hooks.pipeline('prompt:build', { runtime: this, input, content });

      let lastError: unknown;
      for (let attempt = 0; attempt <= MAX_TURN_RETRIES; attempt++) {
        if (attempt > 0) {
          // Restore client state to before the turn, clearing any partial tool results.
          if (preTurnSnapshot) {
            agent.restoreClientSnapshot(preTurnSnapshot);
          }
          this.responseBuffers.set(agent, '');

          micaLogger.logRuntime(
            'runtime',
            'turn:retry',
            {
              attempt,
              maxRetries: MAX_TURN_RETRIES,
              error: lastError instanceof Error ? lastError.message : String(lastError),
            },
            'warn',
          );

          if (this.isActiveAgent(agent)) {
            micaUi.conversation.clearResponseText();
            micaUi.panels.thinkingText.set('');
            micaUi.panels.status.connecting();
          }

          await waitForRetryDelay(agent, TURN_RETRY_DELAY_MS);
        }

        try {
          const result = await agent.run(content, {
            onIterationComplete: () => this.takeQueuedIterationInput(agent),
          });
          runId = result.runId;
          const finalText = result.text;
          if (!agent.isCurrent(runId)) return;

          const responseBuffer = this.responseBuffers.get(agent) ?? '';
          this.responseBuffers.set(agent, '');
          if (session) {
            session.uiState = normalizeUiState({
              ...session.uiState,
              conversationMessages: agent.toConversationMessages(),
              responseText: '',
            });
          }
          if (this.isActiveAgent(agent)) {
            micaUi.conversation.appendAssistantMessage([
              { type: 'text', text: responseBuffer || finalText || '(empty response)' },
            ]);
            micaUi.conversation.clearResponseText();
          }

          await this.hooks.emit('turn:beforePersist', { runtime: this, input, content, result });
          sessionController.saveCurrent();
          micaLogger.logRuntime('runtime', 'turn:saved', { runId, chars: (finalText || responseBuffer).length });
          return;
        } catch (error) {
          if (error instanceof AgentAbortError) {
            throw error;
          }
          lastError = error;
          if (hadToolCall || !micaAgent.isRetryableError(error) || attempt >= MAX_TURN_RETRIES) {
            throw error;
          }
          await this.hooks.emit('turn:error', { runtime: this, input, content, error });
        }
      }
    } catch (error) {
      if (error instanceof AgentAbortError) {
        wasAborted = true;
        runId = error.runId;
        const responseBuffer = this.responseBuffers.get(agent) ?? '';
        this.responseBuffers.set(agent, '');
        let currentTurnAlreadyCommitted = false;
        if (!this.clearingAgents.has(agent)) {
          currentTurnAlreadyCommitted = agent.preserveAbortedTurn(content, responseBuffer);
        }
        if (session && !this.clearingAgents.has(agent)) {
          const conversationMessages = appendAbortedResponseForDisplay(
            agent.toConversationMessages(),
            responseBuffer,
            currentTurnAlreadyCommitted,
          );
          session.uiState = normalizeUiState({
            ...session.uiState,
            conversationMessages,
            responseText: '',
            lastTurnOutcome: 'aborted',
          });
        }
        await this.hooks.emit('turn:abort', { runtime: this, input, content, error });
        if (!this.clearingAgents.has(agent)) sessionController.saveCurrent();
        if (this.isActiveAgent(agent)) this.events.publish({ type: 'turn:aborted', input, owner: agent });
        micaLogger.logRuntime(
          'runtime',
          this.clearingAgents.has(agent) ? 'turn:aborted_cleared' : 'turn:aborted_saved',
          { runId, chars: responseBuffer.length },
          'warn',
        );
        return;
      }

      hasError = true;
      await this.hooks.emit('turn:error', { runtime: this, input, content, error });
      const errorLogItem = micaUi.createErrorLogItem({
        id: `error-${Date.now()}`,
        title: '请求失败',
        error,
      });
      if (session) {
        session.uiState = normalizeUiState({
          ...session.uiState,
          responseText: '',
          thinkingText: '',
          workingStatus: { type: 'error' },
          lastTurnOutcome: 'error',
          agentTurnLogItems: [...session.uiState.agentTurnLogItems, errorLogItem],
        });
      }
      if (this.isActiveAgent(agent)) {
        this.events.publish({ type: 'turn:error', input, error, owner: agent });
        micaUi.conversation.clearResponseText();
        micaUi.panels.thinkingText.set('');
        micaUi.panels.status.error();
        micaUi.panels.appendAgentTurnLogItem(errorLogItem);
      }
    } finally {
      agent.events.off('toolCall', markToolCall);
      this.runningAgents.delete(agent);
      this.clearingAgents.delete(agent);
      if (!hasError && !wasAborted && session) {
        session.uiState = normalizeUiState({
          ...session.uiState,
          logEntries: [],
          agentTurnLogItems: [],
          thinkingText: '',
          lastTurnOutcome: 'completed',
        });
      }
      if (!hasError && !wasAborted && this.isActiveAgent(agent)) micaUi.panels.clearLogEntries();
      const elapsedMs = Date.now() - startedAt;
      if (this.isActiveAgent(agent)) this.events.publish({ type: 'turn:finished', input, elapsedMs, owner: agent });
      this.hookAgent = agent;
      try {
        await this.hooks.emit('turn:after', { runtime: this, input, elapsedMs, hasError });
      } finally {
        this.hookAgent = null;
      }
      micaLogger.logRuntime('runtime', 'turn:finish', { elapsedMs, hasError });
    }
  }

  private takeQueuedIterationInput(agent: AgentRuntime): AgentQueryContent | null {
    const queue = this.queueFor(agent);
    const next = queue.dequeueByMode('after_iteration');
    this.events.publish({ type: 'queue:changed', pendingInputs: queue.list(), owner: agent });
    if (!next) return null;

    const responseBuffer = this.responseBuffers.get(agent) ?? '';
    if (responseBuffer) {
      const session = getActiveContext<RuntimeActiveContext>()?.agentSessions.findByAgent(agent);
      if (session) {
        session.uiState = normalizeUiState({
          ...session.uiState,
          conversationMessages: agent.toConversationMessages(),
          responseText: '',
        });
      }
      this.responseBuffers.set(agent, '');
      if (this.isActiveAgent(agent)) {
        micaUi.conversation.appendAssistantMessage([{ type: 'text', text: responseBuffer }]);
        micaUi.conversation.clearResponseText();
      }
    }

    const content = micaUi.parseImageRefs(next.text) as AgentQueryContent;
    const session = getActiveContext<RuntimeActiveContext>()?.agentSessions.findByAgent(agent);
    if (session) {
      session.uiState = normalizeUiState({
        ...session.uiState,
        conversationMessages: [...agent.toConversationMessages(), { role: 'user', content }],
      });
    }
    if (this.isActiveAgent(agent)) {
      micaUi.conversation.appendUserMessage(content);
      micaUi.conversation.clearResponseText();
    }
    micaLogger.logRuntime('runtime', 'submit:queued_iteration', { chars: next.text.length, queued: queue.count() });
    return content;
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
}

function shouldClearPreviousTurnUi(outcome: TerminalAgentTurnOutcome | undefined): boolean {
  return outcome === undefined || outcome === 'idle' || outcome === 'completed' || outcome === 'error';
}

function waitForRetryDelay(agent: AgentRuntime, delayMs: number): Promise<void> {
  const delayRunId = agent.activeRunId;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      fn();
    };
    const timer = setTimeout(() => finish(resolve), delayMs);
    const poll = setInterval(() => {
      if (agent.activeRunId !== delayRunId) {
        finish(() => reject(new AgentAbortError(agent.activeRunId)));
      }
    }, 300);
  });
}

function appendAbortedResponseForDisplay(
  messages: ReturnType<AgentRuntime['toConversationMessages']>,
  responseText: string,
  appendResponse: boolean,
): ReturnType<AgentRuntime['toConversationMessages']> {
  const text = responseText.trim();
  if (!appendResponse || !text) return messages;
  return [...messages, { role: 'assistant', content: [{ type: 'text', text: responseText }] }];
}

function appendBoundedText(previous: string, chunk: string, maxChars: number, marker: string): string {
  const next = `${previous}${chunk}`;
  if (next.length <= maxChars) return next;
  const body = next.startsWith(marker) ? next.slice(marker.length) : next;
  return `${marker}${body.slice(-(maxChars - marker.length))}`;
}

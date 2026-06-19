import type { AgentQueryContent } from '@packages/mica-agent/index.js';
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
  type SubmitOptions,
  type SubmitResult,
} from '@packages/mica-runtime/index.js';
import { AgentAbortError, type AgentRuntime } from '../../agent/AgentRuntime.js';
import type { SessionController } from '../../session/SessionController.js';
import { reportRuntimeError } from '../../runtime/uiBridge.js';
import { getActiveApplication } from '../Application.js';
import { normalizeUiState } from '../../agents/terminalAgentSessions.js';
import {
  RewindCheckpointManager,
  type RewindApplyResult,
  type RewindPreviewResult,
} from '../../runtime/RewindCheckpointManager.js';

const ALLOW_DURING_EXCLUSIVE_TASK_COMMANDS = new Set(['log', 'status', 'agents', 'new']);

export class LocalRuntimeController implements RuntimeController {
  readonly events = new micaRuntime.RuntimeEventBus();
  readonly queue = {
    enqueue: (input: RuntimeInput) => this.queueFor(this.queueAgent()).enqueue(input),
    dequeue: () => this.queueFor(this.queueAgent()).dequeue(),
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
    const next = `${this.responseBuffers.get(this.agent) ?? ''}${text}`;
    this.responseBuffers.set(this.agent, next);
    return next;
  }

  appendResponseTextFor(agent: AgentRuntime, text: string): string {
    const next = `${this.responseBuffers.get(agent) ?? ''}${text}`;
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

    const input = micaRuntime.createRuntimeInput(text, options.source ?? 'ui');
    const targetAgent = this.submissionAgent(options);
    const targetSessionController = this.sessionControllers.get(targetAgent) ?? this.sessionController;
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

    const inputHook = await this.hooks.guard('input:received', {
      runtime: this,
      input,
      isCommand: false,
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

    micaLogger.logRuntime('runtime', 'turn:start', { chars: input.text.length });
    this.rewindCheckpoints.capture(agent, input);
    this.responseBuffers.set(agent, '');
    const session = getActiveApplication()?.activeContext?.agentSessions.findByAgent(agent);
    if (session) {
      session.uiState = normalizeUiState({
        ...session.uiState,
        conversationMessages: [...agent.toConversationMessages(), { role: 'user', content }],
        responseText: '',
        pendingInputs: [],
        logEntries: [],
        agentTurnLogItems: [],
        thinkingText: '',
        workingStatus: { type: 'connecting' },
      });
    }
    if (this.isActiveAgent(agent)) {
      this.events.publish({ type: 'turn:started', input, owner: agent });
      micaUi.terminalInput.clearText();
      micaUi.conversation.appendUserMessage(content);
      micaUi.conversation.clearResponseText();
      micaUi.panels.clearLogEntries();
      micaUi.panels.status.connecting();
    }

    try {
      await this.hooks.emit('turn:before', { runtime: this, input, content });
      await this.hooks.pipeline('prompt:build', { runtime: this, input, content });

      const result = await agent.run(content);
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
          { type: 'text', text: finalText || responseBuffer || '(empty response)' },
        ]);
        micaUi.conversation.clearResponseText();
      }

      await this.hooks.emit('turn:beforePersist', { runtime: this, input, content, result });
      sessionController.saveCurrent();
      micaLogger.logRuntime('runtime', 'turn:saved', { runId, chars: (finalText || responseBuffer).length });
    } catch (error) {
      if (error instanceof AgentAbortError) {
        runId = error.runId;
        const responseBuffer = this.responseBuffers.get(agent) ?? '';
        this.responseBuffers.set(agent, '');
        if (!this.clearingAgents.has(agent)) {
          agent.preserveAbortedTurn(content, responseBuffer);
        }
        if (session && !this.clearingAgents.has(agent)) {
          session.uiState = normalizeUiState({
            ...session.uiState,
            conversationMessages: agent.toConversationMessages(),
            responseText: '',
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
      const message = error instanceof Error ? error.message : String(error);
      if (session) {
        session.uiState = normalizeUiState({
          ...session.uiState,
          responseText: '',
          thinkingText: '',
          workingStatus: { type: 'error', message },
          agentTurnLogItems: [
            micaUi.createErrorLogItem({
              id: `error-${Date.now()}`,
              title: '请求失败',
              error,
            }),
          ],
        });
      }
      if (this.isActiveAgent(agent)) {
        this.events.publish({ type: 'turn:error', input, error, owner: agent });
        reportRuntimeError(error, '请求失败');
      }
    } finally {
      this.runningAgents.delete(agent);
      this.clearingAgents.delete(agent);
      if (!hasError && session) {
        session.uiState = normalizeUiState({
          ...session.uiState,
          agentTurnLogItems: [],
          thinkingText: '',
        });
      }
      if (!hasError && this.isActiveAgent(agent)) micaUi.panels.clearAgentTurnLogItems();
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

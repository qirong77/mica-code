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

export class LocalRuntimeController implements RuntimeController {
  readonly events = new micaRuntime.RuntimeEventBus();
  readonly queue = new micaRuntime.MessageQueueService();
  private running = false;
  private responseBuffer = '';

  constructor(
    private readonly agent: AgentRuntime,
    private readonly sessionController: SessionController,
    private readonly commands: CommandRegistry,
    private readonly hooks: HookRegistry,
    private readonly services: ServiceContainer,
  ) {}

  async start(): Promise<void> {
    await this.hooks.emit('runtime:start', { runtime: this });
  }

  async stop(): Promise<void> {
    await this.hooks.emit('runtime:stop', { runtime: this });
  }

  getStatus(): RuntimeStatus {
    return { running: this.running };
  }

  getSnapshot(): RuntimeViewSnapshot {
    return {
      status: this.getStatus(),
      pendingInputs: this.queue.list(),
    };
  }

  appendResponseText(text: string): string {
    this.responseBuffer += text;
    return this.responseBuffer;
  }

  clearResponseBuffer(): void {
    this.responseBuffer = '';
  }

  clear(): void {
    this.responseBuffer = '';
    this.queue.clear();
    this.events.publish({ type: 'queue:changed', pendingInputs: this.queue.list() });
  }

  async submit(rawText: string, options: SubmitOptions = {}): Promise<SubmitResult> {
    const text = rawText.trim();
    if (!text) return { ok: false, reason: 'empty' };

    const parsedCommand = this.commands.resolve(text);
    if (parsedCommand) {
      if (this.running && parsedCommand.command.allowDuringTurn !== true) {
        this.events.publish({
          type: 'notification',
          level: 'warn',
          message: '当前任务运行中，稍后再执行该命令',
        });
        return { ok: false, reason: 'busy' };
      }

      await this.hooks.emit('command:before', { runtime: this, command: parsedCommand.command, args: parsedCommand.args });
      const result = await this.commands.execute(text, { runtime: this, services: this.services });
      await this.hooks.emit('command:after', { runtime: this, command: parsedCommand.command, args: parsedCommand.args, result });
      if (!result.ok) {
        this.events.publish({
          type: 'notification',
          level: 'error',
          message: result.error instanceof Error ? result.error.message : String(result.error),
        });
        return { ok: false, reason: 'command_failed', error: result.error };
      }
      return { ok: true, handled: true };
    }

    const input = micaRuntime.createRuntimeInput(text, options.source ?? 'ui');
    micaLogger.logRuntime('runtime', 'submit', { chars: text.length, running: this.running });

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

    if (this.running) {
      this.events.publish({
        type: 'notification',
        level: 'warn',
        message: '当前任务运行中',
      });
      return { ok: false, reason: 'busy' };
    }

    await this.runTurn(inputHook.event.input);
    return { ok: true };
  }

  async abort(): Promise<AbortResult> {
    if (!this.running) return { ok: false, reason: 'not_running' };
    try {
      micaLogger.logRuntime('runtime', 'abort:requested', undefined, 'warn');
      this.agent.abort();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: 'error', error };
    }
  }

  private async runTurn(input: RuntimeInput): Promise<void> {
    this.running = true;
    const startedAt = Date.now();
    const content = micaUi.parseImageRefs(input.text) as AgentQueryContent;
    let runId: number | null = null;
    let hasError = false;

    micaLogger.logRuntime('runtime', 'turn:start', { chars: input.text.length });
    this.responseBuffer = '';
    this.events.publish({ type: 'turn:started', input });
    micaUi.terminalInput.clearText();
    micaUi.conversation.appendUserMessage(content);
    micaUi.conversation.clearResponseText();
    micaUi.panels.clearLogEntries();
    micaUi.panels.status.connecting();

    try {
      await this.hooks.emit('turn:before', { runtime: this, input, content });
      await this.hooks.pipeline('prompt:build', { runtime: this, input, content });

      const result = await this.agent.run(content);
      runId = result.runId;
      const finalText = result.text;
      if (!this.agent.isCurrent(runId)) return;

      micaUi.conversation.appendAssistantMessage([
        { type: 'text', text: finalText || this.responseBuffer || '(empty response)' },
      ]);
      micaUi.conversation.clearResponseText();

      await this.hooks.emit('turn:beforePersist', { runtime: this, input, content, result });
      this.sessionController.saveCurrent();
      micaLogger.logRuntime('runtime', 'turn:saved', { runId, chars: (finalText || this.responseBuffer).length });
    } catch (error) {
      if (error instanceof AgentAbortError) {
        runId = error.runId;
        this.agent.preserveAbortedTurn(content, this.responseBuffer);
        await this.hooks.emit('turn:abort', { runtime: this, input, content, error });
        this.sessionController.saveCurrent();
        this.events.publish({ type: 'turn:aborted', input });
        micaLogger.logRuntime('runtime', 'turn:aborted_saved', { runId, chars: this.responseBuffer.length }, 'warn');
        return;
      }

      hasError = true;
      await this.hooks.emit('turn:error', { runtime: this, input, content, error });
      this.events.publish({ type: 'turn:error', input, error });
      reportRuntimeError(error, '请求失败');
    } finally {
      const ownsCurrentTurn = runId == null || this.agent.isCurrent(runId);
      if (ownsCurrentTurn) {
        this.running = false;
        if (!hasError) micaUi.panels.clearAgentTurnLogItems();
      }
      const elapsedMs = Date.now() - startedAt;
      this.events.publish({ type: 'turn:finished', input, elapsedMs });
      await this.hooks.emit('turn:after', { runtime: this, input, elapsedMs, hasError });
      micaLogger.logRuntime('runtime', 'turn:finish', { elapsedMs, hasError });
    }
  }
}

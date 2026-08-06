import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { chdir } from 'node:process';
import setupModelEffortContext from '../../buildin-plugins/model-effort-context/index.mjs';
import { micaConfig } from '@packages/mica-config/index.js';
import { micaMcp } from '@packages/mica-mcp/index.js';
import { micaTools, terminateCurrentBackgroundTasks } from '@packages/mica-tools/index.js';
import { micaSession, type PersistedSession, type SessionTurnLease } from '@packages/mica-session/index.js';
import { micaRuntime } from '@packages/mica-runtime/index.js';
import { AgentRuntime } from '../agent/AgentRuntime.js';
import { SubagentTaskManager } from '../agents/SubagentTaskManager.js';
import { HeadlessTurnExecutor, type HeadlessTurnEvent } from '../runtime/HeadlessTurnExecutor.js';
import { SessionController } from '../session/SessionController.js';
import { ToolAgent } from '../tools/ToolAgent.js';
import type { DaemonCommand } from './SyncClient.js';

export type ExecutorCallbacks = {
  onEvents: (sessionId: string, events: Array<Record<string, unknown>>) => void;
  onSessionSaved: (session: PersistedSession) => void;
};

const TOOL_RESULT_TRUNCATE = 4000;

type SessionHost = {
  sessionId: string;
  agent: AgentRuntime;
  sessionController: SessionController;
  subagentTasks: SubagentTaskManager;
  executor: HeadlessTurnExecutor;
};

/**
 * Executes remote "continue conversation" turns on this machine. One turn runs
 * at a time; while busy, inputs for the *same* session queue up and get real
 * after_iteration injection through the shared HeadlessTurnExecutor. MCP stays
 * connected for the daemon lifetime while per-session agents are kept alive
 * between turns (continuous in-memory context), so repeated turns skip session
 * reload and MCP re-init.
 */
export class CommandExecutor {
  private readonly hosts = new Map<string, SessionHost>();
  private readonly disposeModelEffortContext = setupModelEffortContext();
  private busy = false;
  private currentSessionId: string | null = null;
  private currentCommandId: string | null = null;
  private activeLease: SessionTurnLease | null = null;

  constructor(private readonly callbacks: ExecutorCallbacks) {}

  get isBusy(): boolean {
    return this.busy;
  }

  get activeSessionId(): string | null {
    return this.currentSessionId;
  }

  async start(): Promise<void> {
    try {
      await micaMcp.init();
    } catch (error) {
      console.error(`[mica-sync] MCP init failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async stop(): Promise<void> {
    for (const host of this.hosts.values()) {
      host.executor.abort();
    }
    await Promise.all([
      cleanup('stop subagents', () => {
        for (const host of this.hosts.values()) void host.subagentTasks.stop();
      }),
      cleanup('stop background tools', () =>
        terminateCurrentBackgroundTasks({ signal: 'SIGTERM', forceAfterMs: 1500 }),
      ),
      cleanup('shut down MCP', () => micaMcp.shutdown(), 5000),
    ]);
    this.releaseLease();
    this.hosts.clear();
    this.disposeModelEffortContext();
  }

  abort(sessionId?: string): void {
    if (sessionId && sessionId !== this.currentSessionId) return;
    const host = sessionId ? this.hosts.get(sessionId) : null;
    if (host) {
      host.executor.abort();
    } else {
      for (const value of this.hosts.values()) value.executor.abort();
    }
  }

  /** Switches a session's working directory without running a turn. */
  async updateCwd(sessionId: string, cwd: string): Promise<void> {
    const store = micaSession.createStore();
    try {
      if (!cwd.trim() || !statSync(cwd).isDirectory()) {
        this.emit(sessionId, [
          {
            type: 'cwd_update',
            sessionId,
            ok: false,
            error: `Working directory is unavailable: ${cwd}`,
          },
        ]);
        return;
      }
      const lease = micaSession.acquireTurnLease(sessionId);
      if (!lease) {
        this.emit(sessionId, [
          {
            type: 'cwd_update',
            sessionId,
            ok: false,
            error: '该会话正在本机终端或另一个进程运行，无法切换工作目录',
          },
        ]);
        return;
      }
      try {
        const session = store.load(sessionId);
        if (!session) {
          this.emit(sessionId, [
            { type: 'cwd_update', sessionId, ok: false, error: `Session not found: ${sessionId}` },
          ]);
          return;
        }
        // Bump revision/updatedAt like saveCurrent does, otherwise the sync
        // server's isNewerSession rejects the snapshot as stale.
        session.cwd = cwd;
        session.revision = (session.revision ?? 0) + 1;
        session.updatedAt = new Date().toISOString();
        store.save(session);
        this.callbacks.onSessionSaved(session);
        this.emit(sessionId, [{ type: 'cwd_update', sessionId, ok: true, cwd }]);
      } finally {
        lease.release();
      }
    } catch (error) {
      this.emit(sessionId, [
        {
          type: 'cwd_update',
          sessionId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
      ]);
    }
  }

  async execute(command: DaemonCommand): Promise<void> {
    if (command.type === 'abort') {
      this.abort(command.sessionId);
      return;
    }
    if (command.type !== 'run' && command.type !== 'create') return;

    const store = micaSession.createStore();
    const session = store.load(command.sessionId);
    if (!session) {
      if (command.type === 'create') {
        await this.createSession(command.sessionId, command.prompt, command.cwd);
        return;
      }
      this.emit(command.sessionId, [
        { type: 'turn', state: 'error', error: `Session not found: ${command.sessionId}` },
      ]);
      return;
    }

    if (this.busy && this.currentSessionId !== command.sessionId) {
      this.emit(command.sessionId, [
        {
          type: 'run_rejected',
          commandId: command.id,
          message: '该机器正在执行另一个远程任务，请稍后再试',
        },
      ]);
      return;
    }

    // Same-session input while busy: queue inside the shared executor.
    if (this.busy) {
      const host = this.hosts.get(command.sessionId);
      if (!host) {
        this.emit(command.sessionId, [
          {
            type: 'run_rejected',
            commandId: command.id,
            message: '该会话正在启动中，请稍后再试',
          },
        ]);
        return;
      }
      const input = micaRuntime.createRuntimeInput(command.prompt, 'ui', { queueMode: 'after_turn' });
      const result = await host.executor.start(input);
      if (result === 'queued') {
        this.emit(command.sessionId, [
          {
            type: 'queued',
            commandId: command.id,
            sessionId: command.sessionId,
            prompt: command.prompt,
            position: host.executor.pendingInputs.length,
          },
        ]);
      } else {
        this.emit(command.sessionId, [
          {
            type: 'run_rejected',
            commandId: command.id,
            message: '该会话排队消息已满，请稍后再试',
          },
        ]);
      }
      return;
    }

    this.busy = true;
    this.currentSessionId = command.sessionId;
    this.currentCommandId = command.id;
    try {
      const lease = micaSession.acquireTurnLease(command.sessionId);
      if (!lease) {
        this.emit(command.sessionId, [
          {
            type: 'run_rejected',
            commandId: command.id,
            message: '该会话正在本机终端或另一个进程运行，请等待完成后再试',
          },
        ]);
        return;
      }
      this.activeLease = lease;

      const host = this.hostFor(session);
      if (!host) {
        this.releaseBusy(command.sessionId);
        return;
      }
      const originalCwd = process.cwd();
      try {
        if (session.cwd && statSync(session.cwd).isDirectory()) {
          chdir(session.cwd);
          // Reload a snapshot changed by another process (e.g. update_cwd).
          host.sessionController.refreshFromStore();
        }
      } catch (error) {
        console.error(
          `[mica-sync] cwd/session refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        try {
          chdir(originalCwd);
        } catch {
          // ignore
        }
      }

      const input = micaRuntime.createRuntimeInput(command.prompt, 'ui');
      const result = await host.executor.start(input);
      if (result === 'rejected') {
        this.emit(command.sessionId, [
          {
            type: 'run_rejected',
            commandId: command.id,
            message: '该会话排队消息已满，请稍后再试',
          },
        ]);
      }
    } catch (error) {
      this.emit(command.sessionId, [
        { type: 'turn', state: 'error', error: error instanceof Error ? error.message : String(error) },
      ]);
    }
  }

  /** Creates a brand-new session from the local config and runs the first turn. */
  private async createSession(sessionId: string, prompt: string, requestedCwd?: string): Promise<void> {
    try {
      const store = micaSession.createStore();
      if (store.load(sessionId)) {
        this.emit(sessionId, [
          {
            type: 'run_rejected',
            commandId: this.currentCommandId,
            message: `Session already exists: ${sessionId}`,
          },
        ]);
        return;
      }
      // The sync server mints the id; the daemon seeds the session with the
      // locally configured provider/model/effort and an empty history.
      const agent = new AgentRuntime();
      const snapshot = agent.getSnapshot();
      const now = new Date().toISOString();
      const session: PersistedSession = {
        version: 1,
        id: sessionId,
        // Non-empty placeholder: parsePersistedSession rejects empty titles,
        // and the first saveCurrent derives the real title from the prompt.
        title: 'Untitled session',
        createdAt: now,
        updatedAt: now,
        cwd: requestedCwd?.trim() || homedir(),
        turnState: 'running',
        snapshot: {
          providerId: snapshot.providerId,
          protocol: snapshot.protocol,
          model: snapshot.model,
          effort: snapshot.effort,
          role: agent.role,
          contextWindowSize: micaConfig.getModelRule(snapshot.model).contextSize,
          messages: [],
          conversationMessages: [],
          usageHistory: [],
          lastUsage: undefined,
          subagentUsageHistory: [],
        },
      };
      // Seed the session file before executeTurn: resumeLoaded records a
      // persisted signature, and saveCurrent refuses to write a session whose
      // file does not already exist on disk.
      store.save(session);
      this.busy = true;
      this.currentSessionId = sessionId;
      this.currentCommandId = null;
      try {
        const lease = micaSession.acquireTurnLease(sessionId);
        if (!lease) {
          this.emit(sessionId, [
            {
              type: 'run_rejected',
              commandId: this.currentCommandId,
              message: '该会话正在本机终端或另一个进程运行，请等待完成后再试',
            },
          ]);
          return;
        }
        this.activeLease = lease;
        const host = this.hostFor(session);
        if (!host) {
          this.releaseBusy(sessionId);
          return;
        }
        const originalCwd = process.cwd();
        try {
          if (session.cwd && statSync(session.cwd).isDirectory()) chdir(session.cwd);
        } catch {
          // ignore
        } finally {
          try {
            chdir(originalCwd);
          } catch {
            // ignore
          }
        }
        const input = micaRuntime.createRuntimeInput(prompt, 'ui');
        const result = await host.executor.start(input);
        if (result === 'rejected') {
          this.emit(sessionId, [
            {
              type: 'run_rejected',
              commandId: this.currentCommandId,
              message: '该会话排队消息已满，请稍后再试',
            },
          ]);
        }
      } catch (error) {
        this.emit(sessionId, [
          { type: 'turn', state: 'error', error: error instanceof Error ? error.message : String(error) },
        ]);
      }
    } catch (error) {
      this.emit(sessionId, [
        { type: 'turn', state: 'error', error: error instanceof Error ? error.message : String(error) },
      ]);
    }
  }

  private hostFor(session: PersistedSession): SessionHost | null {
    const existing = this.hosts.get(session.id);
    if (existing) return existing;
    try {
      const agent = new AgentRuntime();
      const sessionController = new SessionController({
        agent,
        // The session snapshot already restores provider/model/effort.
        config: { apply() {} },
        ui: {
          restore() {
            // Headless executor has no interactive UI.
          },
        },
      });
      const subagentTasks = new SubagentTaskManager();
      micaTools.registerRuntime(new ToolAgent(agent, subagentTasks));

      const resumed = sessionController.resumeLoaded(session);
      if (!resumed.ok) {
        this.emit(session.id, [{ type: 'turn', state: 'error', error: resumed.message }]);
        return null;
      }

      void micaConfig.ensureModelRule(agent.config.model).catch((error) => {
        console.error(
          `[mica-sync] model metadata unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

      const executor = new HeadlessTurnExecutor({
        agent,
        sessionController,
        onEvent: (event) => this.emitHostEvent(session.id, event),
        onIdle: () => this.releaseBusy(session.id),
      });

      this.attachAgentEvents(agent, session.id);
      const host: SessionHost = { sessionId: session.id, agent, sessionController, subagentTasks, executor };
      this.hosts.set(session.id, host);
      return host;
    } catch (error) {
      this.emit(session.id, [
        { type: 'turn', state: 'error', error: error instanceof Error ? error.message : String(error) },
      ]);
      return null;
    }
  }

  private attachAgentEvents(agent: AgentRuntime, sessionId: string): void {
    const emitText = (text: string) => this.emit(sessionId, [{ type: 'text_delta', text }]);
    const emitThinking = (text: string) => this.emit(sessionId, [{ type: 'thinking', text }]);
    const emitToolCall = (event: { name: string; args: string; id?: string }) =>
      this.emit(sessionId, [{ type: 'tool_call', toolId: event.id ?? null, name: event.name, args: event.args }]);
    const emitToolResult = (event: { name: string; result: string; id?: string }) =>
      this.emit(sessionId, [
        {
          type: 'tool_result',
          toolId: event.id ?? null,
          name: event.name,
          ok: !/^(error|failed|✗)/i.test(event.result),
          result: truncateText(event.result, TOOL_RESULT_TRUNCATE),
        },
      ]);
    const emitStatus = (status: unknown) => this.emit(sessionId, [{ type: 'status', status }]);
    const emitUsage = (usage: unknown) => this.emit(sessionId, [{ type: 'usage', usage }]);

    agent.events.on('text', emitText);
    agent.events.on('thinking', emitThinking);
    agent.events.on('toolCall', emitToolCall);
    agent.events.on('toolResult', emitToolResult);
    agent.events.on('status', emitStatus);
    agent.events.on('usage', emitUsage);
  }

  private emitHostEvent(sessionId: string, event: HeadlessTurnEvent): void {
    switch (event.type) {
      case 'turn:start':
        this.emit(sessionId, [
          { type: 'turn', state: 'running', commandId: this.currentCommandId },
          { type: 'user_input', text: event.input.text, commandId: this.currentCommandId },
        ]);
        break;
      case 'turn:finish':
        if (event.status === 'completed') {
          this.emit(sessionId, [{ type: 'turn', state: 'completed' }]);
        } else if (event.status === 'aborted') {
          this.emit(sessionId, [{ type: 'turn', state: 'aborted' }]);
        } else {
          this.emit(sessionId, [{ type: 'turn', state: 'error', error: event.error ?? 'unknown error' }]);
        }
        this.pushLatestSession(sessionId);
        break;
      case 'queued':
        this.emit(sessionId, [
          {
            type: 'queued',
            sessionId,
            prompt: event.input.text,
            position: event.position,
            queueMode: event.input.queueMode ?? 'after_turn',
          },
        ]);
        break;
      case 'dequeue':
        this.emit(sessionId, [{ type: 'dequeue', sessionId, prompt: event.input.text }]);
        break;
      case 'queue:changed':
        this.emit(sessionId, [
          {
            type: 'queue_state',
            sessionId,
            queuedCount: event.pending.length,
            queuedItems: event.pending.map((input, index) => ({
              id: input.id,
              text: input.displayText ?? input.text,
              position: index + 1,
            })),
          },
        ]);
        break;
    }
  }

  private releaseBusy(sessionId: string): void {
    if (this.currentSessionId !== sessionId) return;
    this.releaseLease();
    this.busy = false;
    this.currentSessionId = null;
    this.currentCommandId = null;
    this.pushLatestSession(sessionId);
  }

  private releaseLease(): void {
    if (this.activeLease) {
      this.activeLease.release();
      this.activeLease = null;
    }
  }

  private pushLatestSession(sessionId: string): void {
    try {
      const store = micaSession.createStore();
      const session = store.load(sessionId);
      if (session) this.callbacks.onSessionSaved(session);
    } catch (error) {
      console.error(`[mica-sync] session push failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private emit(sessionId: string, events: Array<Record<string, unknown>>): void {
    this.callbacks.onEvents(sessionId, events);
  }
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (${text.length - max} chars truncated)`;
}

async function cleanup(label: string, action: () => unknown | Promise<unknown>, timeoutMs = 2000): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`cleanup timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    console.error(`Failed to ${label}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { chdir } from 'node:process';
import setupModelEffortContext from '../../buildin-plugins/model-effort-context/index.mjs';
import { micaConfig } from '@packages/mica-config/index.js';
import { micaMcp } from '@packages/mica-mcp/index.js';
import { micaTools, terminateCurrentBackgroundTasks } from '@packages/mica-tools/index.js';
import { micaSession, type PersistedSession, type SessionTurnLease } from '@packages/mica-session/index.js';
import { AgentAbortError, AgentRuntime } from '../agent/AgentRuntime.js';
import { SubagentTaskManager } from '../agents/SubagentTaskManager.js';
import { SessionController } from '../session/SessionController.js';
import { ToolAgent } from '../tools/ToolAgent.js';
import type { DaemonCommand } from './SyncClient.js';

export type ExecutorCallbacks = {
  onEvents: (sessionId: string, events: Array<Record<string, unknown>>) => void;
  onSessionSaved: (session: PersistedSession) => void;
};

const TOOL_RESULT_TRUNCATE = 4000;

/**
 * Executes remote "continue conversation" turns on this machine. One turn runs
 * at a time; overlapping requests are rejected with an event. MCP stays
 * connected for the daemon lifetime while per-turn agents are recreated.
 */
export class CommandExecutor {
  private busy = false;
  private currentSessionId: string | null = null;
  private currentCommandId: string | null = null;
  private agent: AgentRuntime | null = null;
  private subagentTasks: SubagentTaskManager | null = null;
  private readonly disposeModelEffortContext = setupModelEffortContext();

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
    if (this.agent) this.agent.abort();
    await Promise.all([
      cleanup('stop subagents', () => this.subagentTasks?.stop()),
      cleanup('stop background tools', () =>
        terminateCurrentBackgroundTasks({ signal: 'SIGTERM', forceAfterMs: 1500 }),
      ),
      cleanup('shut down MCP', () => micaMcp.shutdown(), 5000),
    ]);
    this.disposeModelEffortContext();
  }

  abort(sessionId?: string): void {
    if (sessionId && sessionId !== this.currentSessionId) return;
    if (this.agent) this.agent.abort();
  }

  /** Switches a session's working directory without running a turn. */
  async updateCwd(sessionId: string, cwd: string): Promise<void> {
    const store = micaSession.createStore();
    try {
      if (!cwd.trim() || !statSync(cwd).isDirectory()) {
        this.emit(sessionId, [
          { type: 'cwd_update', sessionId, ok: false, error: `Working directory is unavailable: ${cwd}` },
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

    if (this.busy) {
      this.emit(command.sessionId, [
        { type: 'run_rejected', commandId: command.id, message: '该机器正在执行另一个远程任务，请稍后再试' },
      ]);
      return;
    }

    this.busy = true;
    this.currentSessionId = command.sessionId;
    this.currentCommandId = command.id;
    try {
      if (command.type === 'create') {
        await this.createTurn(command.sessionId, command.prompt, command.cwd);
      } else {
        await this.runTurn(command.sessionId, command.prompt);
      }
    } finally {
      this.busy = false;
      this.currentSessionId = null;
      this.currentCommandId = null;
    }
  }

  private async runTurn(sessionId: string, prompt: string): Promise<void> {
    const store = micaSession.createStore();
    const session = store.load(sessionId);
    if (!session) {
      this.emit(sessionId, [{ type: 'turn', state: 'error', error: `Session not found: ${sessionId}` }]);
      return;
    }
    await this.executeTurn(session, prompt);
  }

  /** Creates a brand-new session from the local config and runs the first turn. */
  private async createTurn(sessionId: string, prompt: string, requestedCwd?: string): Promise<void> {
    try {
      const store = micaSession.createStore();
      if (store.load(sessionId)) {
        this.emit(sessionId, [
          { type: 'run_rejected', commandId: this.currentCommandId, message: `Session already exists: ${sessionId}` },
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
          messages: [],
          conversationMessages: [],
          usageHistory: [],
          lastUsage: undefined,
        },
      };
      // Seed the session file before executeTurn: resumeLoaded records a
      // persisted signature, and saveCurrent refuses to write a session whose
      // file does not already exist on disk.
      store.save(session);
      await this.executeTurn(session, prompt, agent);
    } catch (error) {
      this.emit(sessionId, [
        { type: 'turn', state: 'error', error: error instanceof Error ? error.message : String(error) },
      ]);
    }
  }

  private async executeTurn(session: PersistedSession, prompt: string, prebuiltAgent?: AgentRuntime): Promise<void> {
    const sessionId = session.id;
    let controller: SessionController | null = null;
    let subagentTasks: SubagentTaskManager | null = null;
    let lease: SessionTurnLease | null = null;
    const originalCwd = process.cwd();

    try {
      lease = micaSession.acquireTurnLease(sessionId);
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

      if (!session.cwd || !statSync(session.cwd).isDirectory()) {
        throw new Error(`Session working directory is unavailable: ${session.cwd || '(empty)'}`);
      }
      chdir(session.cwd);

      this.agent = prebuiltAgent ?? new AgentRuntime();
      const agent = this.agent;
      subagentTasks = new SubagentTaskManager();
      this.subagentTasks = subagentTasks;
      controller = new SessionController({
        agent,
        // The session snapshot already restores provider/model/effort.
        config: { apply() {} },
        ui: {
          restore() {
            // Headless executor has no interactive UI.
          },
        },
      });
      micaTools.registerRuntime(new ToolAgent(agent, subagentTasks));

      const resumed = controller.resumeLoaded(session);
      if (!resumed.ok) {
        this.emit(sessionId, [{ type: 'turn', state: 'error', error: resumed.message }]);
        return;
      }

      void micaConfig.ensureModelRule(agent.config.model).catch((error) => {
        console.error(
          `[mica-sync] model metadata unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

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

      this.emit(sessionId, [
        { type: 'turn', state: 'running', commandId: this.currentCommandId },
        { type: 'user_input', text: prompt, commandId: this.currentCommandId },
      ]);
      controller.saveCurrent({ allowEmpty: true, turnState: 'running' });

      try {
        await agent.run(prompt);
        controller.saveCurrent({ turnState: 'completed' });
        this.emit(sessionId, [{ type: 'turn', state: 'completed' }]);
      } catch (error) {
        if (error instanceof AgentAbortError) {
          agent.preserveAbortedTurn(prompt, undefined);
          controller.saveCurrent({ turnState: 'aborted' });
          this.emit(sessionId, [{ type: 'turn', state: 'aborted' }]);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          controller.saveCurrent({ turnState: 'error' });
          this.emit(sessionId, [{ type: 'turn', state: 'error', error: message }]);
        }
      }
      this.pushLatestSession(sessionId);
    } catch (error) {
      this.emit(sessionId, [
        { type: 'turn', state: 'error', error: error instanceof Error ? error.message : String(error) },
      ]);
    } finally {
      this.agent = null;
      if (this.subagentTasks === subagentTasks) this.subagentTasks = null;
      micaTools.unregisterRuntime('Agent');
      await Promise.all([
        cleanup('stop subagents', () => subagentTasks?.stop()),
        cleanup('stop background tools', () =>
          terminateCurrentBackgroundTasks({ signal: 'SIGTERM', forceAfterMs: 1500 }),
        ),
      ]);
      try {
        chdir(originalCwd);
      } catch (error) {
        console.error(
          `[mica-sync] failed to restore daemon cwd: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      lease?.release();
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

import { hostname } from 'node:os';
import { loadDaemonConfig, saveDaemonConfig } from './config.js';
import { SyncClient } from './SyncClient.js';
import { CommandExecutor } from './CommandExecutor.js';
import { SessionWatcher, sessionDir } from './SessionWatcher.js';
import { isPidAlive, readDaemonPid, removeDaemonPid, writeDaemonPid } from './ensureDaemonRunning.js';
import { micaConfig } from '@packages/mica-config/index.js';
import type { PersistedSession } from '@packages/mica-session/index.js';
import type { DaemonCommand } from '@packages/mica-sync-protocol/index.js';
import { VERSION } from '../../buildMeta.js';

export type DaemonOptions = {
  server?: string;
  name?: string;
};

const BEAT_INTERVAL_MS = 20_000;
const RETRY_DELAY_MS = 3_000;
const EVENT_BATCH_MS = 40;
const EVENT_BATCH_SIZE = 50;

function defaultMachineName(): string {
  return hostname().replace(/\.local$/, '');
}

function log(message: string): void {
  console.log(`[mica-sync ${new Date().toISOString()}] ${message}`);
}

function logError(message: string): void {
  console.error(`[mica-sync ${new Date().toISOString()}] ${message}`);
}

/**
 * Snapshots saved by older mica processes lack `contextWindowSize`. Fill it in
 * from the model rule before pushing so the web console can render ctx% for
 * every session, not just ones saved after the field was introduced.
 */
function withContextWindowSize(session: PersistedSession): PersistedSession {
  const snapshot = (session.snapshot ?? {}) as Record<string, unknown>;
  if (typeof snapshot.contextWindowSize === 'number' || !snapshot.model) return session;
  try {
    const size = micaConfig.getModelRule(String(snapshot.model)).contextSize;
    return {
      ...session,
      snapshot: { ...(snapshot as object), contextWindowSize: size } as PersistedSession['snapshot'],
    };
  } catch {
    return session;
  }
}

/**
 * `mica daemon` entry: a long-running process that mirrors local sessions to a
 * central mica-sync server and executes remote continuation requests.
 */
export async function runDaemon(options: DaemonOptions = {}): Promise<void> {
  const existing = loadDaemonConfig();
  const serverUrl = (options.server ?? existing?.serverUrl ?? '').trim().replace(/\/+$/, '');
  if (!serverUrl) {
    console.error('mica daemon needs a sync server.\n' + 'Usage: mica daemon --server <url> [--name <machine-name>]');
    process.exit(2);
  }

  // Only one daemon per MICA_HOME. Refuse to start when a live daemon already
  // wrote its pid (covers racing `mica` invocations auto-starting the daemon).
  const runningPid = readDaemonPid();
  if (runningPid && isPidAlive(runningPid)) {
    console.error(`mica daemon already running (pid ${runningPid})`);
    process.exit(0);
  }
  writeDaemonPid(process.pid);
  process.on('exit', removeDaemonPid);

  const config = {
    serverUrl,
    machineId: existing?.machineId,
    name: options.name ?? existing?.name,
  };
  saveDaemonConfig(config);

  let client = new SyncClient(serverUrl);
  if (config.machineId) client.setMachineId(config.machineId);

  const ensureRegistered = async (): Promise<void> => {
    log(`registering with sync server at ${serverUrl}`);
    const registered = await client.register(
      config.name || defaultMachineName(),
      hostname(),
      process.platform,
      VERSION,
    );
    config.machineId = registered.machineId;
    config.name = registered.name;
    saveDaemonConfig(config);
    client.setMachineId(registered.machineId);
    log(`registered as "${registered.name}" (${config.machineId})`);
  };

  const executor = new CommandExecutor({
    onEvents: (sessionId, events) => {
      pusher.push(sessionId, events);
    },
    onSessionSaved: (session) => {
      void client.pushSession(withContextWindowSize(session)).catch((error) => {
        logError(`session push failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
  });

  const watcher = new SessionWatcher(sessionDir(), (session, sessionId) => {
    if (session) {
      void client.pushSession(withContextWindowSize(session)).catch((error) => {
        logError(`session push failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    } else {
      void client.deleteSession(sessionId).catch((error) => {
        logError(`session delete failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  });

  const pusher = new EventPusher(client, (message) => logError(`event push failed: ${message}`));

  const handleCommands = async (commands: DaemonCommand[]): Promise<void> => {
    for (const [index, command] of commands.entries()) {
      if (command.type === 'run' || command.type === 'create') {
        log(
          `${command.type} command for session ${command.sessionId}: ${command.prompt.slice(0, 80)}${command.prompt.length > 80 ? '…' : ''}`,
        );
        void executor.execute(command);
      } else if (command.type === 'abort') {
        log(`abort command for session ${command.sessionId}`);
        const pendingCommand = commands
          .slice(index + 1)
          .find(
            (candidate) =>
              (candidate.type === 'run' || candidate.type === 'create') && candidate.sessionId === command.sessionId,
          );
        executor.abort(command.sessionId, pendingCommand?.id);
      } else if (command.type === 'update_cwd') {
        log(`update_cwd command for session ${command.sessionId}: ${command.cwd}`);
        void executor.updateCwd(command.sessionId, command.cwd);
      }
    }
  };

  const pollLoop = async (): Promise<void> => {
    while (running) {
      try {
        const commands = await client.poll();
        await handleCommands(commands);
      } catch (error) {
        if (!running) return;
        logError(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  };

  const beatLoop = async (): Promise<void> => {
    while (running) {
      await sleep(BEAT_INTERVAL_MS);
      if (!running) return;
      try {
        await client.beat({ sessionId: executor.activeSessionId, running: executor.isBusy });
      } catch (error) {
        logError(`beat failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  let running = true;
  const stop = async (): Promise<void> => {
    if (!running) return;
    running = false;
    log('shutting down');
    watcher.stop();
    await executor.stop();
    process.exit(0);
  };

  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());

  try {
    await ensureRegistered();
  } catch (error) {
    logError(`registration failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  await executor.start();
  watcher.start();
  log(`daemon running — mirroring sessions to ${serverUrl}`);

  void pollLoop();
  void beatLoop();
  // Keep the event loop alive; poll/beat loops run on timers and fetches.
  // stop() exits the process explicitly.
  await new Promise<void>(() => undefined);
}

/**
 * Batches per-session event pushes and sends them serially so the sync server
 * publishes SSE frames in the exact order the local agent emitted them.
 */
class EventPusher {
  private readonly queue = new Map<string, Array<Record<string, unknown>>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(
    private readonly client: SyncClient,
    private readonly onError: (message: string) => void,
  ) {}

  push(sessionId: string, events: Array<Record<string, unknown>>): void {
    const batch = this.queue.get(sessionId) ?? [];
    batch.push(...events);
    this.queue.set(sessionId, batch);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, EVENT_BATCH_MS);
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (;;) {
        let next: [string, Array<Record<string, unknown>>] | null = null;
        for (const [sessionId, events] of this.queue) {
          if (events.length > 0) {
            next = [sessionId, events];
            break;
          }
        }
        if (!next) break;
        const [sessionId, events] = next;
        const batch = events.splice(0, EVENT_BATCH_SIZE);
        if (events.length === 0) this.queue.delete(sessionId);
        try {
          await this.client.pushEvents(sessionId, batch);
        } catch (error) {
          this.onError(error instanceof Error ? error.message : String(error));
          // Drop the failed batch; retrying out-of-order events can duplicate
          // deltas in the web UI. The next session snapshot push is the
          // authoritative recovery path.
        }
      }
    } finally {
      this.flushing = false;
      if (this.queue.size > 0 && !this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.flush();
        }, EVENT_BATCH_MS);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

import { resolve } from 'node:path';
import setupModelEffortContext from '../../../../plugins/builtin/model-effort-context/index.mjs';
import { micaConfig } from '@packages/mica-config/index.js';
import { micaMcp } from '@packages/mica-mcp/index.js';
import { micaPlugin } from '@packages/mica-plugin/index.js';
import { createStdoutCodexExecWriter, type CodexExecEventWriter } from '@packages/mica-runtime/index.js';
import { micaRuntime } from '@packages/mica-runtime/index.js';
import { micaTools, terminateCurrentBackgroundTasks } from '@packages/mica-tools/index.js';
import { AgentAbortError, AgentRuntime } from '../agent/AgentRuntime.js';
import type { AgentRuntimeConfigOverride } from '../agent/AgentRuntimeConfig.js';
import { SubagentTaskManager } from '../agents/SubagentTaskManager.js';
import { attachCodexExecProjector, type CodexExecProjector } from '../runtime/CodexExecProjector.js';
import { HeadlessTurnExecutor } from '../runtime/HeadlessTurnExecutor.js';
import { SessionController } from '../session/SessionController.js';
import { ToolAgent } from '../tools/ToolAgent.js';
import { createHeadlessPluginHost, startAsSubmit } from '../headless/HeadlessPluginHost.js';
import { resolveRuntimeConfigOverride } from './modelCatalog.js';

export type HeadlessExecOptions = {
  prompt: string;
  sessionId?: string;
  cwd?: string;
  model?: string;
  variant?: string;
  role?: string;
  maxTurns?: number;
  thinking?: boolean;
  json?: boolean;
  noSave?: boolean;
  mcpConfigPath?: string;
  strictMcpConfig?: boolean;
  mcpInitTimeoutMs?: number;
  writer?: CodexExecEventWriter;
  signal?: AbortSignal;
};

export type HeadlessExecResult = {
  status: 'completed' | 'aborted' | 'error';
  sessionId: string;
  text: string;
  error?: string;
  exitCode: number;
};

export async function runExec(options: HeadlessExecOptions): Promise<HeadlessExecResult> {
  const json = options.json === true;
  const writer = options.writer ?? (json ? createStdoutCodexExecWriter() : { write() {} });
  const prompt = options.prompt.trim();
  let agent: AgentRuntime | null = null;
  let sessionController: SessionController | null = null;
  let subagentTasks: SubagentTaskManager | null = null;
  let projector: CodexExecProjector | null = null;
  let host: ReturnType<typeof createHeadlessPluginHost> | null = null;
  let executor: HeadlessTurnExecutor | null = null;
  let sessionId = '';
  let mcpStarted = false;
  let status: 'completed' | 'aborted' | 'error' = 'completed';
  let text = '';
  let errorMessage: string | undefined;
  const disposeModelEffortContext = setupModelEffortContext();

  const onAbort = () => executor?.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    throwIfAborted(options.signal);
    if (!prompt) throw new Error('Headless exec requires a non-empty prompt');
    if (options.cwd) process.chdir(resolve(options.cwd));

    const runtimeOverride = resolveRuntimeConfigOverride(micaConfig.get(), options.model, options.variant);
    let initialModel = runtimeOverride.model ?? micaConfig.get().model;
    if (!initialModel) {
      const config = micaConfig.get();
      const provider = config.providers.find((item) => item.id === config.provider);
      if (provider?.get_model_url) {
        try {
          await micaConfig.loadProviderModels(provider.id);
          initialModel = runtimeOverride.model ?? micaConfig.get().model;
        } catch {
          // Best-effort: dynamic model discovery may fail in restricted networks.
        }
      }
    }
    await ensureHeadlessModelRule(initialModel, options.signal);
    throwIfAborted(options.signal);

    const hooks = new micaPlugin.HookRegistry();
    agent = new AgentRuntime(runtimeOverride, hooks);
    sessionController = new SessionController({
      agent,
      // AgentRuntime.loadSnapshot restores the provider/model from the session
      // itself. Avoid persisting a daemon-selected model into Mica's user-level
      // last-used preferences while running headlessly.
      config: { apply() {} },
      ui: {
        restore() {
          // Headless mode has no interactive UI to restore.
        },
      },
    });
    subagentTasks = new SubagentTaskManager();
    micaTools.registerRuntime(new ToolAgent(agent, subagentTasks));

    if (options.sessionId) {
      const resumed = sessionController.resume(options.sessionId);
      if (!resumed.ok) {
        errorMessage = resumed.message;
        console.error(`No conversation found with session ID: ${options.sessionId}`);
        writer.write({ type: 'error', message: resumed.message });
        return resultFor('error', options.sessionId, '', resumed.message);
      }
      await ensureHeadlessModelRule(runtimeOverride.model ?? agent.config.model, options.signal);
      if (hasRuntimeOverride(runtimeOverride)) {
        agent.configureForRun(runtimeOverride, true);
      } else {
        agent.configureForRun(
          {
            providerId: agent.config.provider.id,
            model: agent.config.model,
            effort: agent.config.effort,
          },
          true,
        );
      }
    }
    if (options.role) agent.setRole(options.role);
    throwIfAborted(options.signal);

    sessionId = sessionController.getCurrentSessionId();
    projector = attachCodexExecProjector(agent, writer, sessionId, { thinking: options.thinking === true });

    executor = new HeadlessTurnExecutor({
      agent,
      sessionController,
      maxTurns: options.maxTurns,
      save: options.noSave !== true,
      onEvent: (event) => {
        if (event.type === 'turn:finish') {
          status = event.status;
          if (event.error) errorMessage = event.error;
        }
      },
    });
    host = createHeadlessPluginHost({
      hooks,
      agent,
      sessionController,
      subagentTasks,
      isBusy: () => executor!.isBusy,
      submit: (inputText, submitOptions) => startAsSubmit((input) => executor!.start(input), inputText, submitOptions),
    });
    executor.attachPluginLayer({
      hooks: host.hooks,
      host,
      queue: host.queue,
      getConversationMessages: host.getConversationMessages,
    });
    await host.emitRuntimeStart();
    throwIfAborted(options.signal);

    mcpStarted = true;
    await micaMcp.init({
      ...(options.mcpConfigPath ? { configPath: resolve(options.mcpConfigPath) } : {}),
      strict: options.strictMcpConfig === true,
      initTimeoutMs: options.mcpInitTimeoutMs,
      parallel: true,
      signal: options.signal,
    });
    throwIfAborted(options.signal);

    try {
      const started = await executor.start(micaRuntime.createRuntimeInput(prompt, 'ui'));
      if (started === 'rejected') throw new Error('The turn was rejected (queue full or blocked)');
      await waitForIdle(executor);
      // Drain pending plugin ops (session_compact / session_rewrite queued by
      // the final turn): a one-shot run has no "next turn" for the applier.
      if (host.hooks) {
        await host.hooks.emit('turn:before', {
          runtime: host,
          input: micaRuntime.createRuntimeInput(prompt, 'ui'),
          content: undefined,
        });
      }
      text = projector.completeText(projector.getText());
      if (status === 'completed') {
        writer.write({ type: 'turn.completed', usage: projector.getUsage() });
      } else if (status === 'aborted') {
        writer.write({ type: 'error', message: 'Turn interrupted by user' });
      } else if (status === 'error' && errorMessage) {
        console.error(errorMessage);
        writer.write({ type: 'error', message: errorMessage });
      }
    } catch (error) {
      text = projector.getText();
      if (error instanceof AgentAbortError || options.signal?.aborted) {
        status = 'aborted';
        writer.write({ type: 'error', message: 'Turn interrupted by user' });
      } else {
        status = 'error';
        errorMessage = error instanceof Error ? error.message : String(error);
        console.error(errorMessage);
        writer.write({ type: 'error', message: errorMessage });
      }
    }

    return resultFor(status, sessionId, text, errorMessage);
  } catch (error) {
    status = options.signal?.aborted ? 'aborted' : 'error';
    errorMessage = error instanceof Error ? error.message : String(error);
    if (status === 'error') {
      console.error(errorMessage);
      writer.write({ type: 'error', message: errorMessage });
    }
    return resultFor(status, sessionId || options.sessionId || '', text, errorMessage);
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    projector?.dispose();
    await cleanup('stop subagents', () => subagentTasks?.stop());
    await Promise.all([
      cleanup('stop background tools', () =>
        terminateCurrentBackgroundTasks({ signal: 'SIGTERM', forceAfterMs: 1500 }),
      ),
      ...(mcpStarted ? [cleanup('shut down MCP', () => micaMcp.shutdown(), 5000)] : []),
    ]);
    if (host) {
      await host.emitRuntimeStop();
      await host.dispose();
    }
    micaTools.unregisterRuntime('Agent');
    disposeModelEffortContext();
  }
}

function waitForIdle(executor: HeadlessTurnExecutor): Promise<void> {
  if (!executor.isBusy) return Promise.resolve();
  return new Promise<void>((resolveIdle) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (!executor.isBusy) {
        clearInterval(timer);
        resolveIdle();
      } else if (Date.now() - startedAt > 30 * 60 * 1000) {
        clearInterval(timer);
        resolveIdle();
      }
    }, 100);
  });
}

function resultFor(
  status: HeadlessExecResult['status'],
  sessionId: string,
  text: string,
  errorMessage?: string,
): HeadlessExecResult {
  return {
    status,
    sessionId,
    text,
    ...(errorMessage ? { error: errorMessage } : {}),
    exitCode: exitCodeForStatus(status),
  };
}

function exitCodeForStatus(status: 'completed' | 'aborted' | 'error'): number {
  switch (status) {
    case 'completed':
      return 0;
    case 'aborted':
      return 130;
    case 'error':
      return 1;
  }
}

async function cleanup(label: string, task: () => Promise<unknown> | void, timeoutMs = 3000): Promise<void> {
  try {
    await Promise.race([Promise.resolve(task()), new Promise((resolveTimeout) => setTimeout(resolveTimeout, timeoutMs))]);
  } catch (error) {
    console.error(`[headless exec] ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AgentAbortError();
}

async function ensureHeadlessModelRule(model: string, signal?: AbortSignal): Promise<void> {
  try {
    await micaConfig.ensureModelRule(model, signal);
  } catch (error) {
    // Headless mode must not pollute protocol stdout: log to stderr and fall
    // back to the generic model rule.
    console.error(`Model metadata unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function hasRuntimeOverride(override: AgentRuntimeConfigOverride): boolean {
  return override.providerId !== undefined || override.model !== undefined || override.effort !== undefined;
}

import { resolve } from 'node:path';
import setupModelEffortContext from '../../buildin-plugins/model-effort-context/index.mjs';
import { TodoWriteTool } from '../../buildin-plugins/todo/TodoTool.js';
import { micaConfig } from '@packages/mica-config/index.js';
import { micaMcp } from '@packages/mica-mcp/index.js';
import { parseImageRefs } from '@packages/mica-ui/utils/imagePaste.js';
import {
  createRunJsonError,
  createRunJsonStepFinish,
  createRunJsonStepStart,
  createStdoutRunJsonWriter,
  emptyRunJsonTokenUsage,
  exitCodeForRunJsonStatus,
  type RunJsonStatus,
  type RunJsonWriter,
} from '@packages/mica-runtime/index.js';
import { micaTools, terminateCurrentBackgroundTasks } from '@packages/mica-tools/index.js';
import { AgentAbortError, AgentRuntime } from '../agent/AgentRuntime.js';
import type { AgentRuntimeConfigOverride } from '../agent/AgentRuntimeConfig.js';
import { SubagentTaskManager } from '../agents/SubagentTaskManager.js';
import { attachRunJsonProjector, type RunJsonProjector } from '../runtime/RunJsonProjector.js';
import { SessionController } from '../session/SessionController.js';
import { ToolAgent } from '../tools/ToolAgent.js';
import { resolveRuntimeConfigOverride } from './modelCatalog.js';

export type HeadlessRunOptions = {
  prompt: string;
  sessionId?: string;
  cwd?: string;
  model?: string;
  variant?: string;
  role?: string;
  maxTurns?: number;
  thinking?: boolean;
  noSave?: boolean;
  mcpConfigPath?: string;
  strictMcpConfig?: boolean;
  mcpInitTimeoutMs?: number;
  writer?: RunJsonWriter;
  signal?: AbortSignal;
};

export type HeadlessRunResult = {
  status: RunJsonStatus;
  sessionId: string;
  text: string;
  error?: string;
  exitCode: number;
};

export async function runHeadless(options: HeadlessRunOptions): Promise<HeadlessRunResult> {
  const writer = options.writer ?? createStdoutRunJsonWriter();
  const prompt = options.prompt.trim();
  let agent: AgentRuntime | null = null;
  let sessionController: SessionController | null = null;
  let subagentTasks: SubagentTaskManager | null = null;
  let todoTool: TodoWriteTool | null = null;
  let projector: RunJsonProjector | null = null;
  let sessionId = '';
  let mcpStarted = false;
  let status: RunJsonStatus = 'completed';
  let text = '';
  let errorMessage: string | undefined;
  const disposeModelEffortContext = setupModelEffortContext();

  const onAbort = () => agent?.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    throwIfAborted(options.signal);
    if (!prompt) throw new Error('Headless run requires a non-empty prompt');
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

    agent = new AgentRuntime(runtimeOverride);
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
    todoTool = new TodoWriteTool();
    micaTools.registerRuntime(todoTool, { primaryAgentOnly: true });

    if (options.sessionId) {
      const resumed = sessionController.resume(options.sessionId);
      if (!resumed.ok) {
        errorMessage = resumed.message;
        console.error(`No conversation found with session ID: ${options.sessionId}`);
        writer.write(createRunJsonError(resumed.message));
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
    projector = attachRunJsonProjector(agent, writer, sessionId, { thinking: options.thinking === true });
    writer.write(createRunJsonStepStart(sessionId));
    if (!options.noSave) sessionController.saveCurrent({ allowEmpty: true, turnState: 'running' });

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
      // Resolve [Image](...) refs into multimodal content blocks like the
      // interactive input path does, so headless consumers (Web Chat) can
      // attach pasted images to a turn.
      const content = await parseImageRefs(prompt);
      const result = await agent.run(content, { maxTurns: options.maxTurns });
      text = projector.completeText(result.text);
      status = 'completed';
      if (!options.noSave) sessionController.saveCurrent({ turnState: 'completed' });
    } catch (error) {
      text = projector.getText();
      if (error instanceof AgentAbortError || options.signal?.aborted) {
        status = 'aborted';
        agent.preserveAbortedTurn(prompt, text || undefined);
        if (!options.noSave) sessionController.saveCurrent({ turnState: 'aborted' });
      } else {
        status = 'error';
        errorMessage = error instanceof Error ? error.message : String(error);
        if (!options.noSave) sessionController.saveCurrent({ turnState: 'error' });
        console.error(errorMessage);
        writer.write(
          createRunJsonError(errorMessage, {
            sessionID: sessionId,
            name: error instanceof Error ? error.name : undefined,
          }),
        );
      }
    }

    writer.write(createRunJsonStepFinish(sessionId, status, projector.getUsage()));
    return resultFor(status, sessionId, text, errorMessage);
  } catch (error) {
    status = options.signal?.aborted ? 'aborted' : 'error';
    errorMessage = error instanceof Error ? error.message : String(error);
    if (!options.noSave && sessionController && sessionId) {
      try {
        sessionController.saveCurrent({
          allowEmpty: true,
          turnState: status === 'aborted' ? 'aborted' : 'error',
        });
      } catch {
        // Keep the original runtime failure as the canonical error.
      }
    }
    if (status === 'error') {
      console.error(errorMessage);
      writer.write(
        createRunJsonError(errorMessage, {
          ...(sessionId ? { sessionID: sessionId } : {}),
          name: error instanceof Error ? error.name : undefined,
        }),
      );
    }
    if (sessionId) {
      writer.write(createRunJsonStepFinish(sessionId, status, projector?.getUsage() ?? emptyRunJsonTokenUsage()));
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
    if (todoTool) micaTools.unregisterRuntime(todoTool);
    micaTools.unregisterRuntime('Agent');
    disposeModelEffortContext();
  }
}

function resultFor(status: RunJsonStatus, sessionId: string, text: string, error?: string): HeadlessRunResult {
  return {
    status,
    sessionId,
    text,
    ...(error ? { error } : {}),
    exitCode: exitCodeForRunJsonStatus(status),
  };
}

function hasRuntimeOverride(override: AgentRuntimeConfigOverride): boolean {
  return override.providerId !== undefined || override.model !== undefined || override.effort !== undefined;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AgentAbortError();
}

async function ensureHeadlessModelRule(model: string, signal?: AbortSignal): Promise<void> {
  try {
    await micaConfig.ensureModelRule(model, signal);
  } catch (error) {
    throwIfAborted(signal);
    console.error(
      `Model metadata unavailable for ${model}; using generic defaults: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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

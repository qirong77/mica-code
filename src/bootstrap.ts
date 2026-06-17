import { micaUI, parseImageRefs } from '../packages/mica-ui/index.js';
import { AgentAbortError, type AgentRuntime, type AgentRuntimeStatus } from './agent/AgentRuntime.js';
import {
  createErrorLogItem,
  createThinkingLogItem,
  createToolCallLogItem,
} from '../packages/agent/ui/AgentTurnLogItems.js';
import { getToolDisplayText } from '../packages/tools/index.js';
import type { SessionController } from './session/SessionController.js';
import { clearRuntimeLogs, logRuntime } from './logger.js';
import type { AgentQueryContent } from '../packages/agent/core/Agent.js';

type BootstrapOptions = {
  agent: AgentRuntime;
  sessionController: SessionController;
  onConfigChanged: () => void;
};

let toolId = 0;
let thinkingId = 0;
let pendingInput: string | null = null;
let running = false;
let responseBuffer = '';
let thinkingBuffer = '';
let activeThinkingId: string | null = null;
const activeToolCalls = new Map<string, { id: string; startTime: number; displayText: string }>();

export function reportRuntimeError(error: unknown, title = '运行错误') {
  const message = error instanceof Error ? error.message : String(error);
  logRuntime('runtime', 'error', { title, message }, 'error');
  micaUI.conversation.clearResponseText();
  micaUI.panels.thinkingText.set('');
  micaUI.panels.status.error(message);
  micaUI.panels.setAgentTurnLogItems([
    createErrorLogItem({
      id: `error-${Date.now()}`,
      title,
      error,
    }),
  ]);
}

function resetActiveTurnUI() {
  pendingInput = null;
  responseBuffer = '';
  thinkingBuffer = '';
  activeThinkingId = null;
  activeToolCalls.clear();
  micaUI.conversation.clearResponseText();
  micaUI.conversation.clearPendingInput();
  micaUI.panels.thinkingText.set('');
  micaUI.panels.clearLogEntries();
  micaUI.panels.clearLog();
  clearRuntimeLogs();
  micaUI.panels.clearPluginUIs();
  micaUI.messageBar.clearMessages();
  micaUI.panels.status.idle();
  micaUI.terminalInput.clearText();
}

export function bootstrap({ agent, sessionController, onConfigChanged }: BootstrapOptions) {
  syncModelDisplay(agent);
  logRuntime('runtime', 'bootstrap');

  agent.events.on('status', (status) => {
    applyStatus(status);
  });
  agent.events.on('text', (text) => {
    endThinkingSegment();
    responseBuffer += text;
    micaUI.conversation.setResponseText(responseBuffer);
  });
  agent.events.on('thinking', (text) => {
    if (!activeThinkingId) {
      activeThinkingId = `thinking-${++thinkingId}`;
      thinkingBuffer = '';
    }
    thinkingBuffer += text;
    micaUI.panels.thinkingText.set(thinkingBuffer);
    micaUI.panels.replaceAgentTurnLogItem(createThinkingLogItem(activeThinkingId, thinkingBuffer));
  });
  agent.events.on('toolCall', ({ name, args, id }) => {
    endThinkingSegment();
    const toolKey = id ?? `${name}-${toolId + 1}`;
    const toolLogId = `tool-${++toolId}`;
    const displayText = (() => {
      try {
        return getToolDisplayText(name, JSON.parse(args));
      } catch {
        return `${name} ${args}`;
      }
    })();
    activeToolCalls.set(toolKey, {
      id: toolLogId,
      startTime: Date.now(),
      displayText,
    });
    logRuntime('runtime.tool', 'ui:add', { name, id: toolKey });
    micaUI.panels.appendAgentTurnLogItem(
      createToolCallLogItem({
        id: toolLogId,
        toolName: name,
        displayText,
        completed: false,
        startTime: activeToolCalls.get(toolKey)!.startTime,
      }),
    );
  });
  agent.events.on('toolResult', ({ name, result, id }) => {
    endThinkingSegment();
    const toolKey = id ?? findFirstActiveToolKey(name);
    const activeTool = toolKey ? activeToolCalls.get(toolKey) : undefined;
    const toolLogId = activeTool?.id ?? `tool-${++toolId}`;
    const startTime = activeTool?.startTime ?? Date.now();
    const displayText = activeTool?.displayText ?? `${name} result`;
    if (toolKey) activeToolCalls.delete(toolKey);
    logRuntime('runtime.tool', 'ui:complete', {
      name,
      id: toolKey,
      elapsedMs: Date.now() - startTime,
      resultChars: result.length,
    });
    micaUI.panels.replaceAgentTurnLogItem(
      createToolCallLogItem({
        id: toolLogId,
        toolName: name,
        displayText,
        completed: true,
        output: result.slice(0, 2000),
        startTime,
        elapsedMs: Date.now() - startTime,
      }),
    );
  });
  agent.events.on('usage', (usage) => {
    micaUI.panels.contextSize.set(usage.totalTokens);
    micaUI.panels.cacheHitRate.set(usage.cacheHitRate);
    logRuntime('runtime', 'usage:displayed', {
      context: usage.totalTokens,
      cacheHitRate: usage.cacheHitRate,
    });
  });

  micaUI.terminalInput.onSubmit((text) => {
    void submit(text, agent, sessionController);
  });

  micaUI.panels.setOnAbortAgent(() => {
    if (!running) return;
    logRuntime('runtime', 'abort:requested', undefined, 'warn');
    agent.abort();
    running = false;
    resetActiveTurnUI();
  });

  onConfigChanged();
}

export function syncModelDisplay(agent: AgentRuntime) {
  micaUI.panels.modelDisplay.name.set(agent.config.model);
  micaUI.panels.modelDisplay.effort.set(agent.config.provider.supportsEffort !== false ? agent.config.effort : 'none');
  micaUI.panels.modelDisplay.contextWindowSize.set(agent.config.provider.contextWindowSize);
  logRuntime('runtime', 'model:display_synced', {
    model: agent.config.model,
    effort: agent.config.provider.supportsEffort !== false ? agent.config.effort : 'none',
  });
}

export function clearUI(agent: AgentRuntime, sessionController?: SessionController) {
  logRuntime('runtime', 'ui:clear');
  running = false;
  pendingInput = null;
  responseBuffer = '';
  thinkingBuffer = '';
  activeThinkingId = null;
  activeToolCalls.clear();
  toolId = 0;
  thinkingId = 0;
  agent.clearSession();
  sessionController?.startNewSession();
  micaUI.conversation.clearMessages();
  micaUI.conversation.clearResponseText();
  micaUI.conversation.clearPendingInput();
  micaUI.panels.thinkingText.set('');
  micaUI.panels.clearLogEntries();
  micaUI.panels.clearLog();
  clearRuntimeLogs();
  micaUI.panels.clearPluginUIs();
  micaUI.messageBar.clearMessages();
  micaUI.panels.contextSize.set(0);
  micaUI.panels.cacheHitRate.set(0);
  micaUI.panels.status.idle();
  micaUI.terminalInput.clearText();
}

export function isAgentRunning() {
  return running;
}

async function submit(rawText: string, agent: AgentRuntime, sessionController: SessionController) {
  const text = rawText.trim();
  if (!text) return;
  logRuntime('runtime', 'submit', { chars: text.length, running });

  if (running) {
    pendingInput = text;
    logRuntime('runtime', 'submit:queued', { chars: text.length });
    micaUI.conversation.setPendingInput(text);
    showMessage('消息已排队，将在当前任务完成后发送');
    micaUI.terminalInput.clearText();
    return;
  }

  await runTurn(text, agent, sessionController);
  while (pendingInput) {
    const next = pendingInput;
    pendingInput = null;
    micaUI.conversation.clearPendingInput();
    await runTurn(next, agent, sessionController);
  }
}

async function runTurn(text: string, agent: AgentRuntime, sessionController: SessionController) {
  running = true;
  const startedAt = Date.now();
  const content = parseImageRefs(text) as AgentQueryContent;
  let runId: number | null = null;
  logRuntime('runtime', 'turn:start', { chars: text.length });
  let hasError = false;
  responseBuffer = '';
  thinkingBuffer = '';
  activeThinkingId = null;
  activeToolCalls.clear();
  micaUI.panels.thinkingText.set('');
  micaUI.terminalInput.clearText();
  micaUI.conversation.appendUserMessage(content);
  micaUI.conversation.clearResponseText();
  micaUI.panels.clearLogEntries();
  micaUI.panels.status.connecting();

  try {
    const result = await agent.run(content);
    runId = result.runId;
    const finalText = result.text;
    if (!agent.isCurrent(runId)) return;
    micaUI.conversation.appendAssistantMessage([
      { type: 'text', text: finalText || responseBuffer || '(empty response)' },
    ]);
    micaUI.conversation.clearResponseText();
    sessionController.saveCurrent();
    logRuntime('runtime', 'turn:saved', { runId, chars: (finalText || responseBuffer).length });
  } catch (error) {
    if (error instanceof AgentAbortError) {
      runId = error.runId;
      return;
    }
    hasError = true;
    reportRuntimeError(error, '请求失败');
  } finally {
    const ownsCurrentTurn = runId == null || agent.isCurrent(runId);
    if (ownsCurrentTurn) {
      endThinkingSegment();
      if (!hasError) micaUI.panels.clearAgentTurnLogItems();
      running = false;
    }
    logRuntime('runtime', 'turn:finish', { elapsedMs: Date.now() - startedAt, hasError });
  }
}

function endThinkingSegment() {
  thinkingBuffer = '';
  activeThinkingId = null;
  micaUI.panels.thinkingText.set('');
}

function findFirstActiveToolKey(toolName: string): string | undefined {
  for (const [key, value] of activeToolCalls) {
    if (value.displayText.startsWith(`${toolName} `)) return key;
  }
  return undefined;
}

function applyStatus(status: AgentRuntimeStatus) {
  switch (status.type) {
    case 'idle':
      micaUI.panels.status.idle();
      break;
    case 'connecting':
      micaUI.panels.status.connecting();
      break;
    case 'thinking':
      micaUI.panels.status.thinking();
      break;
    case 'streaming':
      micaUI.panels.status.streaming();
      break;
    case 'calling_tool':
      micaUI.panels.status.callingTool(status.toolNames);
      break;
    case 'completed':
      micaUI.panels.status.completed(status.elapsedMs);
      break;
    case 'error':
      micaUI.panels.status.error(status.message);
      break;
  }
}

export function showMessage(text: string, ttl = 3000) {
  const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  micaUI.messageBar.addMessage({ id, text });
  setTimeout(() => micaUI.messageBar.removeMessage(id), ttl);
}

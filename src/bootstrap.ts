import { micaUI } from "../packages/mica-ui/index.js";
import type { AgentRuntime, AgentRuntimeStatus } from "./agent/AgentRuntime.js";
import {
  createErrorLogItem,
  createThinkingLogItem,
  createToolCallLogItem,
} from "../packages/agent/AgentTurnLogItems.js";
import { getToolDisplayText } from "../packages/tools/index.js";
import type { SessionController } from "./session/SessionController.js";

type BootstrapOptions = {
  agent: AgentRuntime;
  sessionController: SessionController;
  onConfigChanged: () => void;
};

let toolId = 0;
let thinkingId = 0;
let pendingInput: string | null = null;
let running = false;
let responseBuffer = "";
let thinkingBuffer = "";
let activeThinkingId: string | null = null;
const activeToolCalls = new Map<
  string,
  { id: string; startTime: number; displayText: string }
>();

export function reportRuntimeError(error: unknown, title = "运行错误") {
  const message = error instanceof Error ? error.message : String(error);
  micaUI.conversation.clearResponseText();
  micaUI.panels.status.error(message);
  micaUI.panels.setAgentTurnLogItems([
    createErrorLogItem({
      id: `error-${Date.now()}`,
      title,
      error,
    }),
  ]);
}

export function bootstrap({
  agent,
  sessionController,
  onConfigChanged,
}: BootstrapOptions) {
  syncModelDisplay(agent);

  agent.events.on("status", (status) => {
    applyStatus(status);
  });
  agent.events.on("text", (text) => {
    endThinkingSegment();
    responseBuffer += text;
    micaUI.conversation.setResponseText(responseBuffer);
  });
  agent.events.on("thinking", (text) => {
    if (!activeThinkingId) {
      activeThinkingId = `thinking-${++thinkingId}`;
      thinkingBuffer = "";
    }
    thinkingBuffer += text;
    micaUI.panels.replaceAgentTurnLogItem(
      createThinkingLogItem(activeThinkingId, thinkingBuffer),
    );
  });
  agent.events.on("toolCall", ({ name, args, id }) => {
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
  agent.events.on("toolResult", ({ name, result, id }) => {
    endThinkingSegment();
    const toolKey = id ?? findFirstActiveToolKey(name);
    const activeTool = toolKey ? activeToolCalls.get(toolKey) : undefined;
    const toolLogId = activeTool?.id ?? `tool-${++toolId}`;
    const startTime = activeTool?.startTime ?? Date.now();
    const displayText = activeTool?.displayText ?? `${name} result`;
    if (toolKey) activeToolCalls.delete(toolKey);
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
  agent.events.on("usage", (usage) => {
    micaUI.panels.contextSize.set(usage.tokens.input + usage.tokens.output);
    micaUI.panels.cacheHitRate.set(usage.prompt_cache.hit_rate);
  });

  micaUI.terminalInput.onSubmit((text) => {
    void submit(text, agent, sessionController);
  });

  micaUI.panels.setOnAbortAgent(() => {
    agent.abort();
    running = false;
    responseBuffer = "";
    micaUI.conversation.clearResponseText();
  });

  onConfigChanged();
}

export function syncModelDisplay(agent: AgentRuntime) {
  micaUI.panels.modelDisplay.name.set(agent.config.model);
  micaUI.panels.modelDisplay.effort.set(
    agent.config.provider.supportsEffort !== false ? agent.config.effort : "none",
  );
  micaUI.panels.modelDisplay.contextWindowSize.set(
    agent.config.provider.contextWindowSize,
  );
}

export function clearUI(
  agent: AgentRuntime,
  sessionController?: SessionController,
) {
  running = false;
  pendingInput = null;
  responseBuffer = "";
  thinkingBuffer = "";
  activeThinkingId = null;
  activeToolCalls.clear();
  toolId = 0;
  thinkingId = 0;
  agent.clearSession();
  sessionController?.startNewSession();
  micaUI.conversation.clearMessages();
  micaUI.conversation.clearResponseText();
  micaUI.conversation.clearPendingInput();
  micaUI.panels.clearLogEntries();
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

async function submit(
  rawText: string,
  agent: AgentRuntime,
  sessionController: SessionController,
) {
  const text = rawText.trim();
  if (!text) return;

  if (running) {
    pendingInput = text;
    micaUI.conversation.setPendingInput(text);
    showMessage("消息已排队，将在当前任务完成后发送");
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

async function runTurn(
  text: string,
  agent: AgentRuntime,
  sessionController: SessionController,
) {
  running = true;
  let hasError = false;
  responseBuffer = "";
  thinkingBuffer = "";
  activeThinkingId = null;
  activeToolCalls.clear();
  micaUI.terminalInput.clearText();
  micaUI.conversation.appendUserMessage(text);
  micaUI.conversation.clearResponseText();
  micaUI.panels.clearLogEntries();
  micaUI.panels.status.connecting();

  try {
    const { runId, text: finalText } = await agent.run(text);
    if (!agent.isCurrent(runId)) return;
    micaUI.conversation.appendAssistantMessage([
      { type: "text", text: finalText || responseBuffer || "(empty response)" },
    ]);
    micaUI.conversation.clearResponseText();
    sessionController.saveCurrent();
  } catch (error) {
    hasError = true;
    reportRuntimeError(error, "请求失败");
  } finally {
    endThinkingSegment();
    if (!hasError) micaUI.panels.clearAgentTurnLogItems();
    running = false;
  }
}

function endThinkingSegment() {
  thinkingBuffer = "";
  activeThinkingId = null;
}

function findFirstActiveToolKey(toolName: string): string | undefined {
  for (const [key, value] of activeToolCalls) {
    if (value.displayText.startsWith(`${toolName} `)) return key;
  }
  return undefined;
}

function applyStatus(status: AgentRuntimeStatus) {
  switch (status.type) {
    case "connecting":
      micaUI.panels.status.connecting();
      break;
    case "thinking":
      micaUI.panels.status.thinking();
      break;
    case "streaming":
      micaUI.panels.status.streaming();
      break;
    case "calling_tool":
      micaUI.panels.status.callingTool(status.toolNames);
      break;
    case "completed":
      micaUI.panels.status.completed(status.elapsedMs);
      break;
    case "error":
      micaUI.panels.status.error(status.message);
      break;
  }
}

export function showMessage(text: string, ttl = 3000) {
  const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  micaUI.messageBar.addMessage({ id, text });
  setTimeout(() => micaUI.messageBar.removeMessage(id), ttl);
}

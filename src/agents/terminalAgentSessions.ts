import { runtimeEnv } from '@packages/mica-config/runtimeEnv.js';
import { AgentRuntime, type AgentRuntimeStatus } from '../agent/AgentRuntime.js';
import { SessionController } from '../session/SessionController.js';
import type {
  MicaUiAgentTurnLogItem,
  MicaUiContentBlockParam,
  MicaUiConversationMessage,
  MessageItem,
  MicaUiPluginUI,
  MicaUiPendingInputQueueMode,
  MicaUiWorkingStatus,
} from '@packages/mica-ui/index.js';

export type TerminalAgentUiState = {
  conversationMessages: MicaUiConversationMessage[];
  responseText: string;
  pendingInputs: string[];
  pendingQueueMode: MicaUiPendingInputQueueMode | null;
  messageBarMessages: MessageItem[];
  agentTurnLogItems: MicaUiAgentTurnLogItem[];
  thinkingText: string;
  pluginUIs: MicaUiPluginUI[];
  workingStatus: MicaUiWorkingStatus;
  lastTurnOutcome: TerminalAgentTurnOutcome;
  contextSize: number;
  cachedTokenRate: number;
};

export type TerminalAgentTurnOutcome = 'idle' | 'running' | 'completed' | 'error' | 'aborted';

export type TerminalAgentSessionRecord = {
  id: string;
  index: number;
  title: string;
  cwd: string;
  providerId: string;
  providerName: string;
  model: string;
  status: MicaUiWorkingStatus;
  current: boolean;
  startedAt: string;
  updatedAt: string;
};

export type TerminalAgentSession = {
  id: string;
  index: number;
  agent: AgentRuntime;
  sessionController: SessionController;
  titleOverride: string | null;
  uiState: TerminalAgentUiState;
  startedAt: string;
  updatedAt: string;
  status: MicaUiWorkingStatus;
  disposeStatusListener: () => void;
};

const MAX_UI_CONVERSATION_MESSAGES = 200;
const MAX_RESPONSE_TEXT_CHARS = runtimeEnv.ui.responseTextMaxChars;
const MAX_PENDING_INPUTS = 1;
const MAX_MESSAGE_BAR_MESSAGES = 8;
const MAX_AGENT_TURN_LOG_ITEMS = 120;
const MAX_THINKING_TEXT_CHARS = runtimeEnv.ui.thinkingTextMaxChars;
const MAX_UI_MESSAGE_TEXT_CHARS = runtimeEnv.ui.messageTextMaxChars;

export class TerminalAgentSessionManager {
  private readonly sessions: TerminalAgentSession[] = [];
  private nextIndex = 1;
  private currentSessionId: string | null = null;

  registerCurrent(agent: AgentRuntime, sessionController: SessionController): void {
    if (this.sessions.some((session) => session.agent === agent)) return;
    const session = this.addSession(agent, sessionController);
    this.currentSessionId = session.id;
  }

  createSession(): TerminalAgentSessionRecord {
    const agent = new AgentRuntime();
    const sessionController = new SessionController(agent);
    const session = this.addSession(agent, sessionController);
    return this.toRecord(session);
  }

  current(): TerminalAgentSession {
    const session = this.sessions.find((entry) => entry.id === this.currentSessionId) ?? this.sessions[0];
    if (!session) throw new Error('No agent session is registered');
    return session;
  }

  findByAgent(agent: AgentRuntime): TerminalAgentSession | undefined {
    return this.sessions.find((session) => session.agent === agent);
  }

  findById(id: string): TerminalAgentSession | undefined {
    return this.sessions.find((session) => session.id === id);
  }

  switchTo(id: string): TerminalAgentSessionRecord | null {
    const session = this.sessions.find((entry) => entry.id === id);
    if (!session) return null;
    session.updatedAt = new Date().toISOString();
    this.currentSessionId = session.id;
    return this.toRecord(session);
  }

  list(): TerminalAgentSessionRecord[] {
    return this.sessions.map((session) => this.toRecord(session));
  }

  setStatusForAgent(agent: AgentRuntime, status: MicaUiWorkingStatus): TerminalAgentSessionRecord | null {
    const session = this.findByAgent(agent);
    if (!session) return null;
    session.status = status;
    session.updatedAt = new Date().toISOString();
    session.uiState = normalizeUiState({ ...session.uiState, workingStatus: status });
    return this.toRecord(session);
  }

  renameCurrent(title: string): TerminalAgentSessionRecord {
    const session = this.current();
    session.titleOverride = normalizeTitle(title);
    session.updatedAt = new Date().toISOString();
    return this.toRecord(session);
  }

  clearIdleSessions(): { cleared: TerminalAgentSessionRecord[]; remaining: TerminalAgentSessionRecord[] } {
    const cleared: TerminalAgentSessionRecord[] = [];
    for (let index = this.sessions.length - 1; index >= 0; index--) {
      const session = this.sessions[index]!;
      if (session.id === this.currentSessionId || isRunningStatus(session.status)) continue;
      cleared.push(this.toRecord(session));
      session.disposeStatusListener();
      session.agent.abort();
      this.sessions.splice(index, 1);
    }
    cleared.reverse();
    if (!this.currentSessionId || !this.sessions.some((session) => session.id === this.currentSessionId)) {
      this.currentSessionId = this.sessions[0]?.id ?? null;
    }
    return { cleared, remaining: this.list() };
  }

  stop(): void {
    for (const session of this.sessions) {
      session.disposeStatusListener();
      session.agent.abort();
    }
    this.sessions.length = 0;
  }

  private addSession(agent: AgentRuntime, sessionController: SessionController): TerminalAgentSession {
    const now = new Date().toISOString();
    const session: TerminalAgentSession = {
      id: `${process.pid}-${Date.now()}-${this.nextIndex}`,
      index: this.nextIndex,
      agent,
      sessionController,
      titleOverride: sessionController.getCurrentTitle(),
      uiState: createEmptyUiState(),
      startedAt: now,
      updatedAt: now,
      status: { type: 'idle' },
      disposeStatusListener: () => undefined,
    };
    this.nextIndex += 1;

    const onStatus = (status: AgentRuntimeStatus) => {
      session.status = toMicaUiWorkingStatus(status);
      session.updatedAt = new Date().toISOString();
    };
    agent.events.on('status', onStatus);
    session.disposeStatusListener = () => agent.events.off('status', onStatus);

    this.sessions.push(session);
    return session;
  }

  private toRecord(session: TerminalAgentSession): TerminalAgentSessionRecord {
    const { provider, model } = session.agent.config;
    return {
      id: session.id,
      index: session.index,
      title:
        session.titleOverride ??
        deriveTitle(
          session.uiState.conversationMessages.length
            ? session.uiState.conversationMessages
            : session.agent.toConversationMessages(),
        ),
      cwd: process.cwd(),
      providerId: provider.id,
      providerName: provider.name ?? provider.id,
      model,
      status: session.status,
      current: session.id === this.currentSessionId,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
    };
  }
}

export function normalizeUiState(state: TerminalAgentUiState): TerminalAgentUiState {
  const pendingInputs = state.pendingInputs.slice(-MAX_PENDING_INPUTS);
  return {
    ...state,
    conversationMessages: state.conversationMessages
      .slice(-MAX_UI_CONVERSATION_MESSAGES)
      .map(sanitizeConversationMessage),
    responseText: tailText(state.responseText, MAX_RESPONSE_TEXT_CHARS),
    pendingInputs,
    pendingQueueMode: pendingInputs.length > 0 ? state.pendingQueueMode : null,
    messageBarMessages: state.messageBarMessages.slice(-MAX_MESSAGE_BAR_MESSAGES),
    agentTurnLogItems: state.agentTurnLogItems.slice(-MAX_AGENT_TURN_LOG_ITEMS),
    thinkingText: tailText(state.thinkingText, MAX_THINKING_TEXT_CHARS),
    lastTurnOutcome: state.lastTurnOutcome ?? 'idle',
  };
}

function createEmptyUiState(): TerminalAgentUiState {
  return {
    conversationMessages: [],
    responseText: '',
    pendingInputs: [],
    pendingQueueMode: null,
    messageBarMessages: [],
    agentTurnLogItems: [],
    thinkingText: '',
    pluginUIs: [],
    workingStatus: { type: 'idle' },
    lastTurnOutcome: 'idle',
    contextSize: 0,
    cachedTokenRate: 0,
  };
}

function deriveTitle(messages: ReturnType<AgentRuntime['toConversationMessages']>): string {
  const firstUserMessage = messages.find((message) => message.role === 'user');
  const text = firstUserMessage ? contentToText(firstUserMessage.content) : '';
  const title = text.replace(/\s+/g, ' ').trim();
  if (!title) return 'New session';
  return title.length > 60 ? `${title.slice(0, 57)}...` : title;
}

function normalizeTitle(title: string): string {
  return title.trim() || 'Untitled session';
}

function contentToText(content: ReturnType<AgentRuntime['toConversationMessages']>[number]['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

export function toMicaUiWorkingStatus(status: AgentRuntimeStatus): MicaUiWorkingStatus {
  switch (status.type) {
    case 'idle':
      return { type: 'idle' };
    case 'connecting':
      return { type: 'connecting', startedAt: status.startedAt };
    case 'thinking':
      return { type: 'thinking', startedAt: status.startedAt };
    case 'streaming':
      return { type: 'streaming', startedAt: status.startedAt };
    case 'calling_tool':
      return { type: 'calling_tool', startedAt: status.startedAt, toolNames: status.toolNames };
    case 'completed':
      return { type: 'completed', startedAt: status.startedAt, elapsedMs: status.elapsedMs };
    case 'error':
      return { type: 'error', message: status.message };
  }
}

function isRunningStatus(status: MicaUiWorkingStatus): boolean {
  return status.type !== 'idle' && status.type !== 'completed' && status.type !== 'error';
}

function tailText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function sanitizeConversationMessage(message: MicaUiConversationMessage): MicaUiConversationMessage {
  return {
    ...message,
    content: sanitizeConversationContent(message.content),
  } as MicaUiConversationMessage;
}

function sanitizeConversationContent(
  content: MicaUiConversationMessage['content'],
): MicaUiConversationMessage['content'] {
  if (typeof content === 'string') return truncateMiddleText(content, MAX_UI_MESSAGE_TEXT_CHARS);

  const blocks: MicaUiContentBlockParam[] = [];
  let omittedImages = 0;
  for (const block of content) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: truncateMiddleText(block.text, MAX_UI_MESSAGE_TEXT_CHARS) });
      continue;
    }
    omittedImages++;
  }

  if (omittedImages > 0 && blocks.length === 0) {
    blocks.push({ type: 'text', text: omittedImages === 1 ? '[Image]' : `[${omittedImages} images]` });
  }
  return blocks.length === 1 && blocks[0]!.type === 'text' ? blocks[0]!.text : blocks;
}

function truncateMiddleText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = `\n\n[message stored for UI truncated, omitted ${text.length - maxChars} chars]\n\n`;
  const budget = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(budget * 0.65);
  const tail = Math.floor(budget * 0.35);
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}

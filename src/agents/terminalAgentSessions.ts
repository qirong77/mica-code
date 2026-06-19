import { AgentRuntime, type AgentRuntimeStatus } from '../agent/AgentRuntime.js';
import { SessionController } from '../session/SessionController.js';
import type {
  MicaUiAgentTurnLogItem,
  MicaUiConversationMessage,
  MicaUiLogEntry,
  MessageItem,
  MicaUiPluginUI,
  MicaUiUILogEntry,
  MicaUiWorkingStatus,
} from '@packages/mica-ui/index.js';

export type TerminalAgentUiState = {
  conversationMessages: MicaUiConversationMessage[];
  responseText: string;
  pendingInputs: string[];
  messageBarMessages: MessageItem[];
  logEntries: MicaUiLogEntry[];
  agentTurnLogItems: MicaUiAgentTurnLogItem[];
  uiLog: MicaUiUILogEntry[];
  thinkingText: string;
  pluginUIs: MicaUiPluginUI[];
  workingStatus: MicaUiWorkingStatus;
  contextSize: number;
  cachedTokenRate: number;
};

export type TerminalAgentSessionRecord = {
  id: string;
  index: number;
  title: string;
  cwd: string;
  providerId: string;
  providerName: string;
  model: string;
  status: string;
  current: boolean;
  startedAt: string;
  updatedAt: string;
};

export type TerminalAgentSession = {
  id: string;
  index: number;
  agent: AgentRuntime;
  sessionController: SessionController;
  uiState: TerminalAgentUiState;
  startedAt: string;
  updatedAt: string;
  status: string;
  disposeStatusListener: () => void;
};

const MAX_UI_CONVERSATION_MESSAGES = 200;
const MAX_RESPONSE_TEXT_CHARS = 80_000;
const MAX_PENDING_INPUTS = 50;
const MAX_MESSAGE_BAR_MESSAGES = 8;
const MAX_LOG_ENTRIES = 200;
const MAX_AGENT_TURN_LOG_ITEMS = 120;
const MAX_UI_LOG_ENTRIES = 200;
const MAX_THINKING_TEXT_CHARS = 40_000;

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
      uiState: createEmptyUiState(),
      startedAt: now,
      updatedAt: now,
      status: 'idle',
      disposeStatusListener: () => undefined,
    };
    this.nextIndex += 1;

    const onStatus = (status: AgentRuntimeStatus) => {
      session.status = formatStatus(status);
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
      title: deriveTitle(session.agent.toConversationMessages()),
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
  return {
    ...state,
    conversationMessages: state.conversationMessages.slice(-MAX_UI_CONVERSATION_MESSAGES),
    responseText: tailText(state.responseText, MAX_RESPONSE_TEXT_CHARS),
    pendingInputs: state.pendingInputs.slice(-MAX_PENDING_INPUTS),
    messageBarMessages: state.messageBarMessages.slice(-MAX_MESSAGE_BAR_MESSAGES),
    logEntries: state.logEntries.slice(-MAX_LOG_ENTRIES),
    agentTurnLogItems: state.agentTurnLogItems.slice(-MAX_AGENT_TURN_LOG_ITEMS),
    uiLog: state.uiLog.slice(-MAX_UI_LOG_ENTRIES),
    thinkingText: tailText(state.thinkingText, MAX_THINKING_TEXT_CHARS),
  };
}

export function createEmptyUiState(): TerminalAgentUiState {
  return {
    conversationMessages: [],
    responseText: '',
    pendingInputs: [],
    messageBarMessages: [],
    logEntries: [],
    agentTurnLogItems: [],
    uiLog: [],
    thinkingText: '',
    pluginUIs: [],
    workingStatus: { type: 'idle' },
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

function contentToText(content: ReturnType<AgentRuntime['toConversationMessages']>[number]['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function formatStatus(status: AgentRuntimeStatus): string {
  if (status.type === 'calling_tool') {
    const tools = status.toolNames?.join(', ');
    return tools ? `calling_tool:${tools}` : 'calling_tool';
  }
  if (status.type === 'completed') return 'idle';
  if (status.type === 'error') return `error:${status.message}`;
  return status.type;
}

function tailText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

import type { AgentRuntime } from '../agent/AgentRuntime.js';
import type { TerminalAgentSession, TerminalAgentSessionManager } from '../agents/terminalAgentSessions.js';

/** An explicit owner must never fall back to whichever session is selected now. */
export function resolvePluginSession(
  sessions: Pick<TerminalAgentSessionManager, 'findByAgent' | 'current'>,
  owner: unknown,
): TerminalAgentSession | undefined {
  return owner === undefined || owner === null ? sessions.current() : sessions.findByAgent(owner as AgentRuntime);
}

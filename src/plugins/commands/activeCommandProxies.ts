import type { CommandAgent, CommandSessionController } from '@packages/mica-builtin-commands/index.js';
import { AgentRuntime } from '../../agent/AgentRuntime.js';
import { getActiveContext } from '../../app/activeContext.js';
import type { ApplicationContext } from '../../app/ApplicationContext.js';
import type { SessionController } from '../../session/SessionController.js';

function currentContext(): ApplicationContext | null {
  return getActiveContext<ApplicationContext>();
}

export function createActiveAgentProxy(fallback: AgentRuntime): CommandAgent {
  const current = () => currentContext()?.agentSessions.current().agent ?? fallback;
  return {
    get config() {
      return current().config;
    },
    get currentRunId() {
      return current().currentRunId;
    },
    get isRunning() {
      return current().isRunning;
    },
    reloadConfig(resetClient?: boolean) {
      current().reloadConfig(resetClient);
    },
    createSubAgent(options?: { systemPrompt?: string; [key: string]: unknown }) {
      return current().createSubAgent(options);
    },
    getSnapshot() {
      return current().getSnapshot();
    },
  };
}

export function createActiveSessionControllerProxy(fallback: SessionController): CommandSessionController {
  const current = () => currentContext()?.agentSessions.current().sessionController ?? fallback;
  return {
    list(limit?: number) {
      return current().list(limit);
    },
    resume(id: string) {
      return current().resume(id);
    },
    startNewSession() {
      current().startNewSession();
    },
    saveCurrent() {
      current().saveCurrent();
    },
  };
}

export function resolveCommandAgent(agent: CommandAgent): AgentRuntime {
  if (agent instanceof AgentRuntime) return agent;
  const current = currentContext()?.agentSessions.current().agent;
  if (current) return current;
  return agent as AgentRuntime;
}

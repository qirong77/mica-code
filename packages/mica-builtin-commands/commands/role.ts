import { micaAgent } from '@packages/mica-agent/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import { showSelectCommand } from '../shared/selectCommand.js';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from '../services.js';

export function createRoleCommand(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
) {
  return {
    name: 'role',
    description: '切换系统提示词 role',
    completionItems: () =>
      micaAgent.roles.list().map((role) => ({
        arg: role.name,
        description: role.builtIn ? 'Mica built-in (read-only)' : role.path,
      })),
    action: (arg?: string) => {
      const targetAgent = services.getCurrentAgent() ?? agent;
      const targetSessionController = services.getCurrentSessionController() ?? sessionController;
      if (services.isAgentBusy(targetAgent)) {
        services.showMessage('Agent is busy; wait or abort before switching role');
        return;
      }

      const roleName = arg?.trim();
      if (roleName) {
        applyRoleSelection(targetAgent, targetSessionController, services, roleName);
        return;
      }

      showRoleSelector(targetAgent, targetSessionController, services);
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

export function cycleNextRole(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
): boolean {
  const targetAgent = services.getCurrentAgent() ?? agent;
  const targetSessionController = services.getCurrentSessionController() ?? sessionController;
  const roles = micaAgent.roles.list();
  if (roles.length === 0) return false;

  const currentIndex = roles.findIndex((role) => role.name === targetAgent.role);
  const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % roles.length : 0;
  const nextRole = roles[nextIndex];
  if (!nextRole) return false;

  return applyRoleSelection(targetAgent, targetSessionController, services, nextRole.name);
}

function showRoleSelector(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
): void {
  const roles = micaAgent.roles.list();
  showSelectCommand({
    id: 'select-role',
    title: `select role (${micaAgent.roles.directory()})`,
    current: agent.role,
    options: roles.map((role) => ({
      name: role.name,
      label: role.name,
      description: role.builtIn ? 'Mica built-in · read-only' : role.path,
    })),
    emptyMessage: 'no roles available',
    filterable: true,
    onSelect: (roleName) => applyRoleSelection(agent, sessionController, services, roleName),
  });
}

function applyRoleSelection(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
  roleName: string,
): boolean {
  try {
    if (services.isAgentBusy(agent)) {
      services.showMessage('Agent is busy; wait or abort before switching role');
      return false;
    }
    const role = micaAgent.roles.get(roleName);
    if (!role) {
      services.showMessage(`Role not found: ${roleName}`, 5000, services.getCurrentAgentSessionId());
      return false;
    }
    if (role.name === agent.role) return true;

    services.showMessage(
      'Role changed, prompt cache may be invalidated. Consider /compact',
      6000,
      services.getCurrentAgentSessionId(),
    );
    agent.setRole(role.name);
    sessionController.saveCurrent();
    services.syncModelDisplay(agent);
    services.showMessage(`Role: ${role.name}`, 3000, services.getCurrentAgentSessionId());
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    services.showMessage(`Switch role failed: ${message}`, 6000, services.getCurrentAgentSessionId());
    return false;
  }
}

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
        services.showNotice('Agent is busy; wait or abort before switching role', undefined, {
          command: '/role',
          status: 'warning',
        });
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
      services.showNotice('Agent is busy; wait or abort before switching role', undefined, {
        command: '/role',
        status: 'warning',
      });
      return false;
    }
    const role = micaAgent.roles.get(roleName);
    if (!role) {
      services.showNotice(`Role not found: ${roleName}`, services.getCurrentAgentSessionId(), {
        command: '/role',
        status: 'warning',
      });
      return false;
    }
    if (role.name === agent.role) return true;

    services.showNotice('Role changed, prompt cache may be invalidated. Consider /compact', services.getCurrentAgentSessionId(), {
      command: '/role',
      status: 'warning',
    });
    agent.setRole(role.name);
    sessionController.saveCurrent();
    services.syncModelDisplay(agent);
    services.showNotice(`Role: ${role.name}`, services.getCurrentAgentSessionId(), {
      command: '/role',
      status: 'success',
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    services.showNotice(`Switch role failed: ${message}`, services.getCurrentAgentSessionId(), {
      command: '/role',
      status: 'error',
    });
    return false;
  }
}

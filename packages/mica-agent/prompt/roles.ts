import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import DEFAULT_SYSTEM_PROMPT from './system.md' with { type: 'text' };

export const DEFAULT_ROLE_NAME = 'default';

export type AgentRole = {
  name: string;
  prompt: string;
  builtIn: boolean;
  path?: string;
};

export function getRolesDirectory(): string {
  const micaHome = process.env.MICA_HOME ? resolve(process.env.MICA_HOME) : join(homedir(), '.mica');
  return join(micaHome, 'role');
}

export function listAgentRoles(): AgentRole[] {
  const roles: AgentRole[] = [defaultRole()];
  const directory = getRolesDirectory();
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return roles;

  try {
    const customRoles = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== DEFAULT_ROLE_NAME)
      .flatMap((entry) => {
        const path = join(directory, entry.name);
        try {
          return [
            {
              name: entry.name,
              prompt: readFileSync(path, 'utf-8'),
              builtIn: false,
              path,
            } satisfies AgentRole,
          ];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    roles.push(...customRoles);
  } catch {
    // Keep the built-in role available when the user role directory cannot be read.
  }

  return roles;
}

export function getAgentRole(name: string): AgentRole | undefined {
  const normalizedName = name.trim();
  if (!normalizedName) return undefined;
  return listAgentRoles().find((role) => role.name === normalizedName);
}

function defaultRole(): AgentRole {
  return {
    name: DEFAULT_ROLE_NAME,
    prompt: DEFAULT_SYSTEM_PROMPT,
    builtIn: true,
  };
}

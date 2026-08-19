import type { PluginContext } from '@packages/mica-plugin/index.js';
import { createResumeCommand } from '../commands/resume.js';
import { commandHostToken } from '@packages/mica-builtin-commands/commandHost.js';

export default function setupCommandResume(ctx: PluginContext): void {
  const host = ctx.services.get(commandHostToken);
  if (!host) throw new Error('resume requires the builtin command host');
  host.registerCommand(ctx, createResumeCommand(host.agent, host.sessionController, host.services));
}

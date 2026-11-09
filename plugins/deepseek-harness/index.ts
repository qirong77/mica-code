import { join } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/index.js';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { createHarnessSupervisor, isSupervisorHealthIssue } from './supervisor.js';

export default function setup(ctx: PluginContext): void {
  if (!ctx.desktop || !ctx.background || !ctx.settings) return;
  const configDir = ctx.paths?.config ?? resolveMicaHome();
  const dataDir = join(configDir, 'plugin-data', ctx.pluginId);
  const supervisor = createHarnessSupervisor({
    dataDir,
    getSettings: () => ctx.settings!.get(),
    report: (level, message) => ctx.health?.report({ level, message }),
    recover: () => {
      const health = ctx.health?.read();
      if (health && isSupervisorHealthIssue(health)) ctx.health?.clear();
    },
  });
  const background = ctx.background.register({
    id: 'deepseek-harness-supervisor',
    every: 5000,
    run: () => supervisor.ensure(),
  });
  supervisor.ensure();
  ctx.onDispose(async () => {
    background.dispose();
    supervisor.dispose();
  });
}

import type { PluginContext } from '@packages/mica-plugin/index.js';
import { createPluginExperience } from '@packages/mica-plugin/PluginExperience.js';
import { EnvironmentController, type Owner } from './controller.js';
import manifest from './plugin.json';
import { createEnvironmentPanel } from './panel.js';
import { EnvironmentReadyTool } from './Tool.js';
import { intervalMs } from './state.js';

export default function setupEnvironmentReady(ctx: PluginContext): void {
  const state = ctx.sessionState;
  const session = ctx.session;
  if (!state || !session || !ctx.tools || !ctx.background)
    throw new Error('Environment Ready 需要会话状态、会话、工具和后台能力');
  const experience = createPluginExperience(ctx, manifest.version);
  const ownerAvailable = (owner: Owner) => session.describe(owner.handle)?.id === owner.id;
  const assertOwner = (owner: Owner) => {
    if (!ownerAvailable(owner)) throw new Error('会话已切换，环境检查结果已作废');
  };
  const controller = new EnvironmentController({
    capture(context) {
      const handle = session.captureOwner?.(context);
      if (handle === undefined || handle === null) throw new Error('Environment Ready 无法捕获会话归属');
      const info = session.describe(handle);
      if (!info) throw new Error('Environment Ready 需要当前会话');
      return { handle, id: info.id };
    },
    ownerAvailable,
    read: (owner) => {
      assertOwner(owner);
      return state.get(owner.handle);
    },
    write: (value, owner) => {
      assertOwner(owner);
      state.set(value, owner.handle);
    },
    track: (event, fields, owner) => experience.track(event, fields, owner),
    report(failed, count) {
      if (failed)
        ctx.health.report({
          level: 'warn',
          message: `${count} 个环境目标中有 ${failed} 个不可达或 HTTP 非 2xx`,
          hint: '打开 Environment Ready 查看逐目标结果，检查服务后重试。',
        });
      else ctx.health.report({ level: 'ok', message: '环境检查已完成，当前结果以面板为准' });
    },
  });
  ctx.onDispose(() => controller.dispose());
  const tool = ctx.tools.register(new EnvironmentReadyTool(controller), { icon: '🔌', primaryAgentOnly: true });
  ctx.onDispose(() => tool.dispose());
  const panel = ctx.desktop?.panel?.(createEnvironmentPanel(controller));
  if (panel) ctx.onDispose(() => panel.dispose());
  const background = ctx.background.register({
    id: 'check-registered-services',
    every: () => intervalMs(ctx.settings?.get().intervalSeconds),
    // Setup never trusts or probes restored statuses immediately.
    async run({ signal }) {
      try {
        const owner = controller.capture();
        await controller.check(owner, { signal });
      } catch {
        experience.track('failure', { surface: 'background', action: 'background-check', outcome: 'error' });
        ctx.health.report({ level: 'warn', message: '环境检查未完成', hint: '打开 Environment Ready 重新检查。' });
      }
    },
  });
  ctx.onDispose(() => background.dispose());
}

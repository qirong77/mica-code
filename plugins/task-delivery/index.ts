import type { PluginContext } from '@packages/mica-plugin/index.js';
import type { AgentObservationEvent } from '@packages/mica-plugin/AgentObservation.js';
import type { RuntimeTurnBeforeHookEvent } from '@packages/mica-runtime/index.js';
import { createPluginExperience } from '@packages/mica-plugin/PluginExperience.js';
import manifest from './plugin.json';
import { TaskDeliveryTool } from './Tool.js';
import { DeliveryEvidence } from './evidence.js';
import { deliveryView } from './panel.js';
import { createDelivery, identifier, sanitizeDelivery } from './state.js';

export default function setup(ctx: PluginContext): void {
  if (!ctx.desktop?.panel || !ctx.session || !ctx.sessionState || !ctx.tools || !ctx.prompt)
    throw new Error('Task Delivery requires desktop session, state, tools and prompt.');
  const state = ctx.sessionState;
  const session = ctx.session;
  const experience = createPluginExperience(ctx, manifest.version);
  const evidence = new DeliveryEvidence();
  const ownerFor = (context?: unknown) => {
    const owner = session.captureOwner?.(context);
    if (!owner || typeof owner !== 'object') throw new Error('Primary session owner unavailable.');
    const info = session.describe(owner);
    if (!info || !identifier(info.id)) throw new Error('Session identity unavailable.');
    return { owner, info };
  };
  const read = (owner: unknown) => sanitizeDelivery(state.get(owner));
  const tool = ctx.tools.register(
    new TaskDeliveryTool({
      read(context) {
        return read(ownerFor(context).owner);
      },
      set(input, context) {
        const { owner, info } = ownerFor(context);
        const next = createDelivery(input, info.id, evidence.select(owner, input.evidenceIds));
        state.set(next, owner);
        experience.track('update', {
          surface: 'tool',
          revision: next.revision,
          count: next.evidence.length,
          outcome: 'success',
        });
        return next;
      },
      clear(context) {
        const { owner } = ownerFor(context);
        state.clear(owner);
        experience.track('clear', { surface: 'tool', outcome: 'success' });
      },
      failure() {
        experience.track('failure', { surface: 'tool', outcome: 'error' });
      },
    }),
    { primaryAgentOnly: true, icon: '📦' },
  );
  ctx.onDispose(() => tool.dispose());
  const before = ctx.hooks.on<RuntimeTurnBeforeHookEvent>('turn:before', (event) => {
    if (event.owner) evidence.begin(event.owner);
  });
  const observation = ctx.hooks.on<AgentObservationEvent>('agent:observe', (event) => evidence.observe(event));
  ctx.onDispose(() => before.dispose());
  ctx.onDispose(() => observation.dispose());
  const panel = ctx.desktop.panel({
    view() {
      const { owner } = ownerFor();
      return deliveryView(read(owner));
    },
    action(input) {
      const { owner } = ownerFor();
      const current = read(owner);
      const parts = input.action.split(':');
      if (parts.length > 2) return { message: '未知操作。' };
      const [action, embeddedRevision] = parts;
      const key = input.key ?? embeddedRevision;
      if (!['impression', 'details', 'dismiss', 'clear'].includes(action!)) return { message: '未知操作。' };
      if (!current || key !== current.revision || (input.key && embeddedRevision && input.key !== embeddedRevision)) {
        if (action !== 'impression')
          experience.track('click', { surface: input.key ? 'card' : 'panel', action, outcome: 'stale' });
        return { message: '交付记录已变化，请刷新后再操作。' };
      }
      if (action === 'impression') {
        experience.track('impression', { surface: 'card', revision: current.revision });
        return {};
      }
      experience.track('click', {
        surface: input.key ? 'card' : 'panel',
        action,
        revision: current.revision,
        outcome: 'success',
      });
      if (action === 'dismiss') {
        state.set({ ...current, dismissedRevision: current.revision }, owner);
        experience.track('dismiss', { surface: 'card', revision: current.revision, outcome: 'dismissed' });
        return { message: '交付卡已收起，记录仍可在面板查看。' };
      }
      if (action === 'clear') {
        state.clear(owner);
        experience.track('clear', { surface: 'panel', revision: current.revision, outcome: 'success' });
        return { message: '交付记录已清除。' };
      }
      return {
        dialog: {
          title: '任务交付 · 模型报告',
          text: current.summary,
          note: '工具引用与验证边界见交付面板。',
          panel: { label: '查看交付详情' },
        },
      };
    },
  });
  ctx.onDispose(() => panel.dispose());
  const prompt = ctx.prompt.section({
    id: 'task-delivery',
    order: 920,
    render: () =>
      'For a substantive completed task, use task_delivery set to record a concise delivery summary, changed files and separate model-reported code/validation/build/deploy statuses. Validation claims remain unverified; only actual observed tool call IDs can be evidence references. Never claim VERIFIED from a model report or infer semantic success merely from a returned tool result. Do not invent evidence or run extra builds/deployments to fill this card.',
  });
  ctx.onDispose(() => prompt.dispose());
}

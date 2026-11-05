import type { PluginPanelHandler, PluginPanelTone } from '@packages/mica-plugin/index.js';
import { EnvironmentController, type Owner } from './controller.js';
import { address, type EnvironmentState, type Target } from './state.js';

function resultOf(controller: EnvironmentController, owner: Owner, state: EnvironmentState, target: Target) {
  const status = controller.liveStatus(owner, state, target.id);
  const previous = state.statuses[target.id];
  const checked = previous ? `上次检查 ${new Date(previous.checkedAt).toLocaleString()}` : '尚未检查';
  if (!status)
    return {
      text: previous ? '未知 · 历史结果待重新检查' : '未知 · 尚未检查',
      sub: checked,
      tone: 'muted' as PluginPanelTone,
    };
  if (!status.reachable) {
    const reason = status.error === 'timeout' ? '超时' : status.error === 'aborted' ? '已取消' : '连接失败';
    return { text: `不可达 · ${reason}`, sub: checked, tone: 'error' as PluginPanelTone };
  }
  if (target.kind === 'tcp') return { text: 'TCP 可达 · 未检查应用健康', sub: checked, tone: 'ok' as PluginPanelTone };
  return {
    text: `可达 · HTTP ${status.statusCode}${status.error === 'redirect' ? ' · 未跟随重定向' : ''}`,
    sub: `${checked} · ${status.healthy ? '2xx' : '非 2xx'}，不代表业务健康`,
    tone: (status.healthy ? 'ok' : 'warn') as PluginPanelTone,
  };
}

export function createEnvironmentPanel(controller: EnvironmentController): PluginPanelHandler {
  return {
    view() {
      const owner = controller.capture();
      const state = controller.read(owner);
      const fresh = state.targets.map((target) => controller.liveStatus(owner, state, target.id));
      const ready = fresh.filter((status) => status?.reachable && status.healthy !== false).length;
      const unknown = fresh.filter((status) => !status).length;
      const summary = `${ready}/${state.targets.length} 可达且检查通过${unknown ? ` · ${unknown} 个未知` : ''}`;
      const key = controller.key(state);
      return {
        title: 'Environment Ready',
        subtitle: '只检查当前任务已登记的本机服务',
        cards:
          state.targets.length && state.dismissedRevision !== state.revision
            ? [
                {
                  id: 'environment',
                  title: '任务环境',
                  summary,
                  tone: (unknown ? 'muted' : ready === state.targets.length ? 'ok' : 'warn') as PluginPanelTone,
                  revision: key,
                  impressionAction: 'impression',
                  actions: [
                    { id: 'check-card', label: '检查', key, tone: 'primary' as const },
                    { id: 'details', label: '详情', key, tone: 'ghost' as const },
                    { id: 'dismiss', label: '收起', key, tone: 'ghost' as const },
                  ],
                },
              ]
            : [],
        sections: [
          {
            title: '服务',
            subtitle: state.targets.length ? summary : '尚未登记服务',
            text: 'HTTP 显示确切状态码；2xx 仅代表协议检查通过，不保证业务健康。TCP 只检查连接。',
            table: {
              columns: [
                { key: 'target', label: '服务', grow: true },
                { key: 'status', label: '检查结果', grow: true },
                { key: 'actions', label: '操作', actions: true },
              ],
              rows: state.targets.map((target) => ({
                key: controller.key(state, target.id),
                cells: {
                  target: { text: target.label, sub: address(target) },
                  status: resultOf(controller, owner, state, target),
                },
                actions: [
                  ...(target.kind === 'http'
                    ? [{ id: 'open', label: '打开', icon: 'external' as const, tone: 'ghost' as const }]
                    : []),
                  { id: 'check', label: '检查', icon: 'refresh' as const, tone: 'ghost' as const },
                  { id: 'remove', label: '移除', icon: 'trash' as const, tone: 'danger' as const },
                ],
              })),
            },
            empty: '当前没有需要持续检查的服务。仅在任务确需持续探测已知本机服务时登记（最多 6 个）。',
            actions: state.targets.length
              ? [
                  { id: 'check-all', label: '检查全部', tone: 'primary' as const },
                  ...(state.dismissedRevision
                    ? [{ id: 'show-card', label: '重新显示摘要', tone: 'ghost' as const }]
                    : []),
                  { id: 'clear', label: '清空目标', tone: 'danger' as const },
                ]
              : [],
          },
        ],
      };
    },
    async action(input) {
      const owner = controller.capture();
      const state = controller.read(owner);
      const fromCard = ['check-card', 'details', 'dismiss', 'impression'].includes(input.action);
      const surface = fromCard ? 'card' : 'panel';
      if (fromCard && !controller.matches(state, input.key)) {
        if (input.action !== 'impression')
          controller.track(
            'click',
            { surface, action: input.action, outcome: 'stale', revision: state.revision },
            owner.handle,
          );
        return { message: '环境清单已更新，请使用最新卡片。' };
      }
      if (input.action === 'impression') {
        controller.track(
          'impression',
          { surface: 'card', action: 'environment', revision: state.revision, count: state.targets.length },
          owner.handle,
        );
        return;
      }
      // Only fixed action ids enter telemetry, never a caller-provided string.
      if (
        ![
          'check-card',
          'details',
          'dismiss',
          'reopen',
          'show-card',
          'check-all',
          'clear',
          'open',
          'check',
          'remove',
        ].includes(input.action)
      )
        return { message: '未知环境操作' };
      const target = ['open', 'check', 'remove'].includes(input.action)
        ? state.targets.find((entry) => controller.matches(state, input.key, entry.id))
        : undefined;
      if (['open', 'check', 'remove'].includes(input.action) && !target) {
        controller.track(
          'click',
          { surface, action: input.action, revision: state.revision, outcome: 'stale' },
          owner.handle,
        );
        return { message: '目标已更新或移除，请刷新后重试。' };
      }
      controller.track(
        'click',
        { surface, action: input.action, revision: state.revision, outcome: 'success' },
        owner.handle,
      );
      try {
        if (input.action === 'dismiss') {
          controller.dismiss(owner);
          return;
        }
        if (input.action === 'show-card') {
          controller.reopen(owner);
          return { message: '已恢复环境摘要' };
        }
        if (input.action === 'details' || input.action === 'reopen') {
          controller.reopen(owner);
          return {
            dialog: { title: '任务环境', text: summaryText(controller, owner, state), panel: { label: '管理服务' } },
          };
        }
        if (input.action === 'clear') {
          controller.replace([], owner, 'panel');
          return { message: '已清空任务环境目标' };
        }
        if (input.action === 'check-card' || input.action === 'check-all') {
          const result = await controller.check(owner, { surface });
          return { message: checkMessage(result.outcome) };
        }
        if (!target) return { message: '目标已更新或移除，请刷新后重试。' };
        if (input.action === 'open')
          return target.kind === 'http' ? { openExternal: target.url } : { message: 'TCP 目标没有网页可打开' };
        if (input.action === 'remove') {
          controller.remove(target.id, owner, 'panel');
          return { message: '已移除目标' };
        }
        const result = await controller.check(owner, { id: target.id, surface: 'panel' });
        return { message: checkMessage(result.outcome) };
      } catch {
        controller.track(
          'failure',
          { surface, action: input.action, revision: state.revision, outcome: 'error' },
          owner.handle,
        );
        return { message: '环境操作未完成，请重新检查或刷新清单。' };
      }
    },
  };
}

function checkMessage(outcome: string): string {
  return outcome === 'busy'
    ? '已有检查进行中'
    : outcome === 'stale'
      ? '目标已更新或检查已取消，旧结果未写入'
      : outcome === 'error'
        ? '检查完成，部分服务不可达或返回非 2xx；详见各行结果'
        : '检查完成';
}
function summaryText(controller: EnvironmentController, owner: Owner, state: EnvironmentState): string {
  return (
    state.targets.map((target) => {
      const result = resultOf(controller, owner, state, target);
      return `${target.label}（${address(target)}）\n${result.text}\n${result.sub}`;
    }).join('\n\n') ||
    '尚未登记本次任务的本机服务。'
  );
}

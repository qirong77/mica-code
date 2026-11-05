import type { PluginPanelDialog, PluginPanelView } from '@packages/mica-plugin/PluginPanel.js';
import type { Delivery, ReportStatus } from './state.js';
const labels: Record<ReportStatus, string> = {
  unknown: '未报告',
  pending: '待完成',
  done: '已完成',
  failed: '失败',
  skipped: '未执行',
};
const escape = (value: string) => value.replace(/[\\`*_{}\[\]()#+.!|>~-]/g, '\\$&');
const list = (values: string[], empty: string) => values.length ? values.map((value) => `- ${escape(value)}`).join('\n') : empty;

export function deliveryDialog(d: Delivery): PluginPanelDialog {
  const evidence = d.evidence.map((item) =>
    `${item.tool} · ${item.id} · ${item.observedAt} · run ${item.runId} · ${item.kind === 'command-exit' ? `命令已结束，退出码 ${item.exitCode}` : '观察到工具返回，结果含义未验证'}`,
  );
  return {
    title: '任务交付 · 模型报告',
    markdown: [
      `## 交付摘要\n${escape(d.summary)}`,
      `## 模型报告的状态\n代码：${labels[d.reports.code]} · 验证：${labels[d.reports.validation]} · 构建：${labels[d.reports.build]} · 部署：${labels[d.reports.deploy]}`,
      `## 变更文件 · 模型报告\n${list(d.changedFiles, '未报告文件')}`,
      `## 验证声明 · 未独立验证\n${list(d.validationClaims, '未报告验证声明')}`,
      `## 部署 · 模型报告\n${escape(d.deploymentReport || '未报告部署来源或结果。')}`,
      `## 历史工具返回引用\n${list(evidence, '无可用工具证据')}\n\n工具返回或退出码 0 不证明测试覆盖、验证或部署成功。`,
      `来源会话：${escape(d.sourceSessionId)} · 保存时间：${escape(d.savedAt)}；历史模型报告，未重新验证工作区。`,
    ].join('\n\n'),
  };
}
export function deliveryView(delivery?: Delivery): PluginPanelView {
  if (!delivery)
    return { title: 'Task Delivery', sections: [{ title: '交付记录', text: '尚无交付记录。' }], cards: [] };
  const d = delivery;
  return {
    title: 'Task Delivery',
    cards:
      d.dismissedRevision === d.revision
        ? []
        : [
            {
              id: 'delivery',
              title: '任务交付 · 模型报告',
              summary: `${d.summary.slice(0, 130)}\n代码${labels[d.reports.code]} · 验证${labels[d.reports.validation]} · 构建${labels[d.reports.build]} · 部署${labels[d.reports.deploy]}`,
              tone: 'muted',
              revision: d.revision,
              impressionAction: `impression:${d.revision}`,
              actions: [
                { id: 'details', label: '查看交付', key: d.revision, tone: 'default' },
                { id: 'dismiss', label: '收起', key: d.revision, tone: 'ghost' },
              ],
            },
          ],
    sections: [
      {
        title: '交付摘要',
        text: d.summary,
        rows: [
          { label: '保存时间', value: d.savedAt },
          { label: '来源会话', value: d.sourceSessionId, wrap: true },
          { label: '来源', value: '历史模型报告；未重新验证工作区' },
        ],
        actions: [{ id: `clear:${d.revision}`, label: '清除交付记录', tone: 'danger' }],
      },
      {
        title: '模型报告的状态',
        subtitle: '以下状态均由模型提供，不是独立证明',
        rows: [
          { label: '代码', value: labels[d.reports.code] },
          { label: '验证', value: labels[d.reports.validation] },
          { label: '构建', value: labels[d.reports.build] },
          { label: '部署', value: labels[d.reports.deploy] },
        ],
      },
      {
        title: '变更文件 · 模型报告',
        items: d.changedFiles.map((path, index) => ({ key: String(index), label: path })),
        empty: '未报告文件',
      },
      {
        title: '验证声明 · 未独立验证',
        items: d.validationClaims.map((claim, index) => ({ key: String(index), label: claim, tone: 'muted' })),
        empty: '未报告验证声明',
      },
      {
        title: '历史工具返回引用',
        subtitle: '调用返回不代表语义验证通过；命令退出 0 也不证明测试覆盖或部署成功',
        items: d.evidence.map((item) => ({
          key: item.id,
          label: `${item.tool} · ${item.id}`,
          value: `${item.observedAt} · run ${item.runId} · ${item.kind === 'command-exit' ? `命令已结束，退出码 ${item.exitCode}` : '观察到工具返回，结果含义未验证'}`,
          tone: 'muted',
        })),
        empty: '无可用工具证据',
      },
      { title: '部署 · 模型报告', text: d.deploymentReport || '未报告部署来源或结果。' },
    ],
  };
}

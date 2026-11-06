import type { PluginPanelView } from '@packages/mica-plugin/PluginPanel.js';
import { showCard, type Checkpoint } from './state.js';
export function handoffDetails(c: Checkpoint): string {
  const escape = (value: string) => value.replace(/[\\`*_{}\[\]()#+.!|<>~-]/g, '\\$&');
  const list = (items: string[]) => (items.length ? items.map((item) => `- ${escape(item)}`).join('\n') : '未记录');
  return [
    `### 历史检查点\n\n${escape(c.checkpoint)}`,
    `### 待继续\n\n${list(c.pending)}`,
    `### 已完成 · 模型报告\n\n${list(c.completed)}`,
    `### 约束与注意事项\n\n${list(c.cautions)}`,
    `保存时间：${escape(c.savedAt)}  \n来源会话：${escape(c.sourceSessionId)}`,
  ].join('\n\n');
}
export function handoffView(checkpoint?: Checkpoint, threshold = 30, now = Date.now()): PluginPanelView {
  if (!checkpoint)
    return { title: 'Context Handoff', sections: [{ title: '历史检查点', text: '尚无历史检查点。' }], cards: [] };
  const c = checkpoint;
  return {
    title: 'Context Handoff',
    cards: showCard(c, threshold, now)
      ? [
          {
            id: 'handoff',
            title: '历史上下文交接',
            summary: `${c.checkpoint.slice(0, 120)}\n${c.pending.length ? `待继续：${c.pending[0]!.slice(0, 80)}${c.pending.length > 1 ? `（共 ${c.pending.length} 项）` : ''}` : '无待办记录'}`,
            tone: 'muted',
            revision: c.revision,
            impressionAction: `impression:${c.revision}`,
            actions: [
              { id: 'continue', label: '继续', key: c.revision, tone: 'primary' },
              { id: 'details', label: '查看', key: c.revision, tone: 'default' },
              { id: 'dismiss', label: '收起', key: c.revision, tone: 'ghost' },
            ],
          },
        ]
      : [],
    sections: [
      {
        title: '历史检查点',
        text: c.checkpoint,
        rows: [
          { label: '保存时间', value: c.savedAt },
          { label: '来源会话', value: c.sourceSessionId, wrap: true },
          { label: '来源', value: '历史模型报告；当前工作区尚未重新核对', wrap: true },
        ],
        actions: [
          { id: `continue:${c.revision}`, label: '生成继续草稿', tone: 'primary' },
          { id: `clear:${c.revision}`, label: '清除历史检查点', tone: 'danger' },
        ],
      },
      {
        title: '历史已完成 · 模型报告',
        items: c.completed.map((label, index) => ({ key: String(index), label })),
        empty: '未记录已完成事项',
      },
      {
        title: '历史待办',
        items: c.pending.map((label, index) => ({ key: String(index), label })),
        empty: '未记录待办',
      },
      {
        title: '历史约束与注意事项',
        items: c.cautions.map((label, index) => ({ key: String(index), label })),
        empty: '未记录注意事项',
      },
    ],
  };
}

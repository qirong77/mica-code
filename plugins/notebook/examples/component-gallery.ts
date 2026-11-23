import { COMPONENT_TEMPLATES } from '../../../packages/mica-editor/componentCatalog.js';

// Print a POST /notes payload. Generating it never contacts a notebook or changes existing notes.
export function componentGalleryNote() {
  const title = 'Mica 组件块图鉴：从读数到做决策';
  const lessons: Record<string, string> = {
    counter: '先点两次按钮，再看数字。计数器只有一个会变化的值，适合用来确认一个新块的点击与重新渲染都正常。',
    metrics: '几个重要数字适合并排读。看指标时先问「度量的是什么，分母是什么」；如果要解释变化的过程，用后面的趋势图比再加一排卡片更合适。',
    'filtered-list': '在搜索框里输入列表中某一项的几个字，再换成不存在的词，最后清空。给长清单加搜索时，“没有匹配项”和“没有数据”是两种不同的结果。',
    calculator: '先记下默认结果，只改一个输入，观察结果如何变化。适合把预算、用量或容量的假设交给读者调整，而不是把每种可能写成一行表格。',
    trend: '切换两个时间范围，比较点与点的起伏。数值卡回答「是多少」，图回答「怎样变化」；这里的图形来自块内数据，不是外部图片。',
    comparison: '先明确比较维度，再筛选或排序。需要逐行核对数字时，把可比较的值放在同一列，比放进几段文字更好读。',
    timeline: '逐步查看每个阶段的动作和完成条件。把流程拆开后，读者一次只需弄清当前这一步，而不用记住整张清单。',
  };
  const sections = COMPONENT_TEMPLATES.flatMap(({ id, name, description, capabilities, code }, i) => [
    `## ${String(i + 1).padStart(2, '0')} · ${name}`,
    `${lessons[id] ?? description}\n\n能力标签：${capabilities.join('、')}`,
    ['```react', code, '```'].join('\n'),
  ]);
  return {
    title,
    markdown: [
      `# ${title}`,
      '这是一篇可以动手试的笔记。每一节都在回答一个问题：什么时候该用一个交互块，而不是再写一段说明？所有数值、人物与任务均为示例，不代表真实业务。',
      '可以顺着大纲跳读，也可以用「演示」逐节讲解。每个块独立运行：输入和点选不会改写笔记，重新打开会回到示例初值；要长期改变数据，请改组件源码。',
      ...sections,
      '## 给 AI 作者：怎样复用这一页',
      '先写一句不看组件也能读懂的结论，再让组件承担一件具体的事：筛选、对比、试算或逐步说明。输入、图和结果需要联动时，放在同一个块里。',
      'Notebook 1.6 的 `GET /modules/blocks` 有模板目录。沿模板的 `path` 取 `markdown` 可以和正文混排；取 `source` 则可以替换示例数据。要修改已有块，先读 `GET /notes/:id/blocks`，再带同次读取的版本 PATCH 目标块，不必重写整篇。',
    ].join('\n\n'),
  };
}

if (import.meta.main) console.log(JSON.stringify(componentGalleryNote()));

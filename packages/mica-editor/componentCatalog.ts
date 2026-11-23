/**
 * Small, dependency-free recipes for component blocks.
 *
 * Keep these as ordinary strings rather than outer template literals.  The
 * component runtime deliberately uses htm, so `${...}` in a recipe must reach
 * the iframe untouched instead of being evaluated while this catalog loads.
 */

export type ComponentTemplate = Readonly<{
  id: string;
  name: string;
  description: string;
  /** Stable labels let an agent choose a recipe by intent instead of guessing from its name. */
  capabilities: readonly string[];
  code: string;
}>;

const COUNTER_CODE = [
  'function App({React, Arco, html}) {',
  '  const {Card, Button, Tag} = Arco;',
  '  const [count, setCount] = React.useState(0);',
  '  return html`<${Card} title="快速原型">',
  '    <p style=${{margin:"0 0 12px"}}>少量代码即可使用 Mica 的 Arco 组件。</p>',
  '    <${Tag} color="arcoblue">可交互</${Tag}>',
  '    <${Button} style=${{marginLeft:8}} type="primary" onClick=${() => setCount(count + 1)}>',
  '      点击了 ${count} 次',
  '    </${Button}>',
  '  </${Card}>`;',
  '}',
].join('\n');

const METRICS_CODE = [
  'function App({React, Arco, html}) {',
  '  const {Card, Statistic, Progress, Tag} = Arco;',
  '  const metrics = [',
  '    {label: "活跃用户", value: 12840, suffix: "人", progress: 72, tone: "green"},',
  '    {label: "转化率", value: 18.6, suffix: "%", progress: 58, tone: "arcoblue"},',
  '    {label: "平均响应", value: 236, suffix: "ms", progress: 84, tone: "orange"},',
  '  ];',
  '  return html`<div style=${{display:"grid",gap:12}}>',
  '    <div style=${{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:12}}>',
  '      ${metrics.map(metric => html`<${Card} key=${metric.label} size="small">',
  '        <${Statistic} title=${metric.label} value=${metric.value} suffix=${metric.suffix} />',
  '        <${Progress} percent=${metric.progress} color=${metric.tone} showText=${false} />',
  '        <${Tag} style=${{marginTop:8}} color=${metric.tone}>本周趋势稳定</${Tag}>',
  '      </${Card}>`)}',
  '    </div>',
  '    <p style=${{margin:0,opacity:.68}}>固定数据适合先让 AI 搭出仪表盘，再替换为真实数据源。</p>',
  '  </div>`;',
  '}',
].join('\n');

const FILTERED_LIST_CODE = [
  'function App({React, Arco, html}) {',
  '  const {Card, Input, Tag} = Arco;',
  '  const [query, setQuery] = React.useState("");',
  '  const items = [',
  '    {id: "a", title: "设计评审", owner: "林墨", state: "进行中", color: "arcoblue"},',
  '    {id: "b", title: "季度回顾", owner: "周宁", state: "已完成", color: "green"},',
  '    {id: "c", title: "发布检查", owner: "陈晓", state: "待开始", color: "orange"},',
  '    {id: "d", title: "用户访谈", owner: "苏禾", state: "进行中", color: "purple"},',
  '  ];',
  '  const visible = items.filter(item => item.title.toLowerCase().includes(query.trim().toLowerCase()));',
  '  const rows = visible.map(item => html`<div key=${item.id} style=${{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,padding:"10px 0",borderBottom:"1px solid var(--color-line)"}}>',
  '    <div><strong>${item.title}</strong><div style=${{fontSize:12,opacity:.65}}>负责人：${item.owner}</div></div>',
  '    <${Tag} color=${item.color}>${item.state}</${Tag}>',
  '  </div>`);',
  '  return html`<${Card} title="可筛选列表" extra=${html`<${Tag} color="arcoblue">${visible.length} 项</${Tag}>`}>',
  '    <${Input} allowClear value=${query} placeholder="搜索项目名称" onChange=${setQuery} />',
  '    <div style=${{display:"grid",gap:0,marginTop:6}}>',
  '      ${rows.length ? rows : html`<p style=${{opacity:.65}}>没有匹配项，换个关键词试试。</p>`}',
  '    </div>',
  '  </${Card}>`;',
  '}',
].join('\n');

const CALCULATOR_CODE = [
  'function App({React, Arco, html}) {',
  '  const {Card, InputNumber, Statistic, Tag} = Arco;',
  '  const [price, setPrice] = React.useState(128);',
  '  const [quantity, setQuantity] = React.useState(3);',
  '  const [discount, setDiscount] = React.useState(10);',
  '  const total = Math.max(0, price * quantity * (1 - discount / 100));',
  '  const numberOrZero = value => Number(value) || 0;',
  '  return html`<${Card} title="参数计算器">',
  '    <div style=${{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:14}}>',
  '      <label style=${{display:"grid",gap:6}}>单价<${InputNumber} min=${0} step=${1} value=${price} onChange=${value => setPrice(numberOrZero(value))} /></label>',
  '      <label style=${{display:"grid",gap:6}}>数量<${InputNumber} min=${0} step=${1} value=${quantity} onChange=${value => setQuantity(numberOrZero(value))} /></label>',
  '      <label style=${{display:"grid",gap:6}}>折扣（%）<${InputNumber} min=${0} max=${100} step=${1} value=${discount} onChange=${value => setDiscount(numberOrZero(value))} /></label>',
  '    </div>',
  '    <div style=${{display:"flex",alignItems:"end",justifyContent:"space-between",gap:16,marginTop:18}}>',
  '      <${Statistic} title="预计总价" value=${total.toFixed(2)} suffix=" 元" />',
  '      <${Tag} color="green">本地即时计算</${Tag}>',
  '    </div>',
  '  </${Card}>`;',
  '}',
].join('\n');

const TREND_CODE = [
  'function App({React, Arco, html}) {',
  '  const {Card, Button, Tag} = Arco;',
  '  const [range, setRange] = React.useState("week");',
  '  const values = range === "week" ? [32, 48, 42, 67, 58, 82, 76] : [28, 38, 35, 52, 47, 64, 59, 78];',
  '  const max = Math.max(...values, 1);',
  '  const points = values.map((value, index) => `${40 + index * 60},${120 - (value / max) * 88}`).join(" ");',
  '  const dots = values.map((value, index) => html`<circle key=${index} cx=${40 + index * 60} cy=${120 - (value / max) * 88} r="4" fill="currentColor" />`);',
  '  return html`<${Card} title="SVG 趋势图" extra=${html`<${Tag} color="arcoblue">${range === "week" ? "近 7 天" : "近 8 周"}</${Tag}>`}>',
  '    <div style=${{display:"flex",gap:8,marginBottom:12}}>',
  '      <${Button} size="small" type=${range === "week" ? "primary" : "secondary"} onClick=${() => setRange("week")}>7 天</${Button}>',
  '      <${Button} size="small" type=${range === "month" ? "primary" : "secondary"} onClick=${() => setRange("month")}>8 周</${Button}>',
  '    </div>',
  '    <svg viewBox="0 0 500 150" role="img" aria-label="固定数据趋势图" style=${{width:"100%",height:"auto",color:"#165dff"}}>',
  '      <line x1="24" y1="120" x2="480" y2="120" stroke="currentColor" opacity=".18" />',
  '      <polyline points=${points} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />',
  '      ${dots}',
  '    </svg>',
  '    <p style=${{margin:"8px 0 0",opacity:.65}}>纯 SVG + 固定本地数据，不需要网络请求。</p>',
  '  </${Card}>`;',
  '}',
].join('\n');

const COMPARISON_CODE = [
  'function App({React, Arco, html}) {',
  '  const {Card, Button, Tag} = Arco;',
  '  const [sortBy, setSortBy] = React.useState("score");',
  '  const [ascending, setAscending] = React.useState(false);',
  '  const options = [',
  '    {id: "a", name: "方案 A", score: 92, effort: "中", fit: "适合快速试验", color: "green"},',
  '    {id: "b", name: "方案 B", score: 78, effort: "低", fit: "适合稳定交付", color: "arcoblue"},',
  '    {id: "c", name: "方案 C", score: 86, effort: "高", fit: "适合长期扩展", color: "orange"},',
  '  ];',
  '  const sorted = [...options].sort((left, right) => {',
  '    const result = sortBy === "score" ? left.score - right.score : left.name.localeCompare(right.name);',
  '    return ascending ? result : -result;',
  '  });',
  '  const rows = sorted.map(option => html`<tr key=${option.id}>',
  '    <th scope="row" style=${{padding:"10px 8px",textAlign:"left"}}>${option.name}</th>',
  '    <td style=${{padding:"10px 8px"}}><strong>${option.score}</strong>/100</td>',
  '    <td style=${{padding:"10px 8px"}}>${option.effort}</td>',
  '    <td style=${{padding:"10px 8px"}}><${Tag} color=${option.color}>${option.fit}</${Tag}></td>',
  '  </tr>`);',
  '  return html`<${Card} title="方案对比" extra=${html`<${Tag} color="arcoblue">${sorted.length} 个方案</${Tag}>`}>',
  '    <div style=${{display:"flex",flexWrap:"wrap",gap:8,marginBottom:10}}>',
  '      <${Button} size="small" type=${sortBy === "score" ? "primary" : "secondary"} onClick=${() => setSortBy("score")}>按评分</${Button}>',
  '      <${Button} size="small" type=${sortBy === "name" ? "primary" : "secondary"} onClick=${() => setSortBy("name")}>按名称</${Button}>',
  '      <${Button} size="small" type="secondary" onClick=${() => setAscending(!ascending)}>${ascending ? "升序" : "降序"}</${Button}>',
  '    </div>',
  '    <div style=${{overflowX:"auto"}}>',
  '      <table style=${{width:"100%",borderCollapse:"collapse",fontSize:13}}>',
  '        <thead><tr><th scope="col" style=${{padding:"8px",textAlign:"left",borderBottom:"1px solid var(--color-line)"}}>方案</th><th scope="col" style=${{padding:"8px",textAlign:"left",borderBottom:"1px solid var(--color-line)"}}>评分</th><th scope="col" style=${{padding:"8px",textAlign:"left",borderBottom:"1px solid var(--color-line)"}}>投入</th><th scope="col" style=${{padding:"8px",textAlign:"left",borderBottom:"1px solid var(--color-line)"}}>适配</th></tr></thead>',
  '        <tbody>${rows}</tbody>',
  '      </table>',
  '    </div>',
  '    <p style=${{margin:"10px 0 0",opacity:.68}}>先确定比较维度，再把排序交给读者；表格只承载短字段。</p>',
  '  </${Card}>`;',
  '}',
].join('\n');

const TIMELINE_CODE = [
  'function App({React, Arco, html}) {',
  '  const {Card, Button, Progress, Tag} = Arco;',
  '  const [step, setStep] = React.useState(0);',
  '  const stages = [',
  '    {title: "收集问题", detail: "把目标、限制和成功标准写成一句话。", done: "得到可验证的问题定义。"},',
  '    {title: "做出原型", detail: "用一个最小组件把关键交互跑通。", done: "读者可以点、填或切换。"},',
  '    {title: "复盘取舍", detail: "记录哪些假设成立，哪些需要继续验证。", done: "下一步有明确的行动。"},',
  '  ];',
  '  const current = stages[step];',
  '  return html`<${Card} title="三步工作流" extra=${html`<${Tag} color="arcoblue">第 ${step + 1} / ${stages.length} 步</${Tag}>`}>',
  '    <${Progress} percent=${((step + 1) / stages.length) * 100} showText=${false} />',
  '    <div aria-live="polite" style=${{padding:"16px 0 10px"}}>',
  '      <h3 style=${{margin:"0 0 6px",fontSize:18}}>${current.title}</h3>',
  '      <p style=${{margin:"0 0 8px"}}>${current.detail}</p>',
  '      <${Tag} color="green">完成条件：${current.done}</${Tag}>',
  '    </div>',
  '    <div style=${{display:"flex",justifyContent:"space-between",gap:8}}>',
  '      <${Button} size="small" disabled=${step === 0} onClick=${() => setStep(Math.max(0, step - 1))}>上一步</${Button}>',
  '      <${Button} size="small" type="primary" disabled=${step === stages.length - 1} onClick=${() => setStep(Math.min(stages.length - 1, step + 1))}>下一步</${Button}>',
  '    </div>',
  '  </${Card}>`;',
  '}',
].join('\n');

export const COMPONENT_TEMPLATES: readonly ComponentTemplate[] = [
  {
    id: 'counter',
    name: '快速原型 / 计数器',
    description: '用 React state 和 Arco Button 做一个最小可交互块。',
    capabilities: ['本地状态', '点击交互', '最小原型'],
    code: COUNTER_CODE,
  },
  {
    id: 'metrics',
    name: '指标卡 / 仪表盘',
    description: '固定指标、进度条和趋势标签，适合展示汇总信息。',
    capabilities: ['指标汇总', '进度展示', '仪表盘'],
    code: METRICS_CODE,
  },
  {
    id: 'filtered-list',
    name: '可筛选列表',
    description: '用 Arco Input 过滤固定列表，并显示空结果状态。',
    capabilities: ['搜索过滤', '空状态', '列表'],
    code: FILTERED_LIST_CODE,
  },
  {
    id: 'calculator',
    name: '参数计算器',
    description: '使用 InputNumber 即时计算总价，演示多个受控参数。',
    capabilities: ['参数输入', '派生计算', '表单'],
    code: CALCULATOR_CODE,
  },
  {
    id: 'trend',
    name: 'SVG 趋势图',
    description: '用原生 SVG 画固定趋势，并切换两组本地数据。',
    capabilities: ['SVG 图表', '数据切换', '可视化'],
    code: TREND_CODE,
  },
  {
    id: 'comparison',
    name: '可排序对比表',
    description: '按评分或名称排序一组方案，把比较维度和适配结论放在同一行。',
    capabilities: ['方案比较', '排序', '数据表'],
    code: COMPARISON_CODE,
  },
  {
    id: 'timeline',
    name: '分步流程 / 时间线',
    description: '逐步查看阶段、说明和完成条件，适合教学、流程和决策引导。',
    capabilities: ['分步讲解', '流程', '进度'],
    code: TIMELINE_CODE,
  },
];

export const DEFAULT_COMPONENT_TEMPLATE_ID = 'counter';
export const DEFAULT_COMPONENT_TEMPLATE =
  COMPONENT_TEMPLATES.find(template => template.id === DEFAULT_COMPONENT_TEMPLATE_ID) ?? COMPONENT_TEMPLATES[0];


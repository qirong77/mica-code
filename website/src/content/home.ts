// 首页结构化内容

export const features = [
  {
    icon: '⚡',
    title: '前缀稳定，缓存优先',
    desc: '会话默认 append-only，尽量锁住 system / history 前缀，长对话仍可维持 96%+ 缓存命中，省 token 更省钱。',
  },
  {
    icon: '⌨️',
    title: '终端原生，不离开 shell',
    desc: 'Ink TUI，信息密度高、键盘优先；多 agent、后台任务、上下文占用一眼可见。',
  },
  {
    icon: '📎',
    title: '文件引用更快',
    desc: '输入 @ 即可搜索当前工作区文件，方向键选择后用 Enter 或 Tab 插入，也支持粘贴图片引用。',
  },
  {
    icon: '🎭',
    title: 'Role 即工作流',
    desc: '/role 整段替换 system prompt，写码、审查、规划各用一套人格；Shift+Tab 可循环切换。',
  },
  {
    icon: '🧩',
    title: '工具可拼装',
    desc: '文件 / 搜索 / shell / 网页 / skills 开箱即用，MCP 接个人脚本与团队服务。',
  },
  {
    icon: '⏪',
    title: '可回退、可压缩',
    desc: '/rewind 可回到所选历史对话节点，有文件检查点时连文件一起恢复；/compact 在上下文吃紧时收束历史。',
  },
];

export const protocolItems = [
  {
    cmd: 'mica run --format json',
    title: '一次性执行',
    desc: '输出 Codex 兼容的 NDJSON 事件流（step_start / text / tool_use / error / step_finish），自带 TodoWrite 计划展示。',
  },
  {
    cmd: 'mica app-server',
    title: '常驻会话进程',
    desc: '每会话一个进程，暴露 Codex v2 App Server 协议子集；连续对话跳过进程启动、session 重载和 MCP 重复初始化。',
  },
  {
    cmd: 'mica compact --session',
    title: '上下文压缩',
    desc: '复用交互式 /compact 的 CompactionService，把压缩后的 checkpoint 写回会话并输出 JSON，供 Web Chat / 脚本消费。',
  },
  {
    cmd: 'mica commit',
    title: '一键 Git 提交',
    desc: '与 /commit 复用同一套确定性分析逻辑：只发一次模型请求生成 commit message，再程序化 add / commit / push。',
  },
];

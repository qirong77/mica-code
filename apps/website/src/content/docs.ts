export const docGroups = [
  {
    label: '开始使用',
    items: [
      { key: 'getting-started', title: '快速开始', description: '安装 Mica，接入模型，完成第一个任务。' },
      { key: 'configuration', title: '模型与配置', description: 'Provider、API 协议、模型列表与环境变量。' },
    ],
  },
  {
    label: '日常工作',
    items: [
      { key: 'desktop', title: '桌面与浏览器', description: '对话、文件、Git、终端与远程访问。' },
      { key: 'commands', title: '命令与快捷键', description: '会话、上下文、任务管理与键盘操作。' },
      { key: 'extensions', title: '扩展与协作', description: 'Skills、MCP、自定义角色与子代理。' },
    ],
  },
  {
    label: '集成与原理',
    items: [
      { key: 'headless', title: '自动化与协议', description: 'mica exec、JSONL 和 app-server 集成。' },
      { key: 'architecture', title: '架构概览', description: '运行时、应用边界与源码导览。' },
      { key: 'benchmark', title: '评测方法', description: 'DeepSWE 任务来源、指标定义与结果范围。' },
    ],
  },
];
export const docPages = docGroups.flatMap((group) => group.items);

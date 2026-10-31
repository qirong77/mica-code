export const docGroups = [
  {
    label: '开始使用',
    items: [
      { key: 'getting-started', title: '快速开始', description: '安装 CLI，连接模型，完成第一个开发任务。' },
      { key: 'configuration', title: '模型与配置', description: '连接模型服务，选择协议、模型与推理强度。' },
      { key: 'desktop', title: '桌面与浏览器', description: '启动工作区，把对话、代码、Git 和终端放在一起。' },
    ],
  },
  {
    label: '日常工作',
    items: [
      { key: 'workflows', title: '日常开发流程', description: '推进长任务，保留上下文，协调多个 agent。' },
      { key: 'commands', title: '命令与快捷键', description: '终端命令、运行中操作与键盘参考。' },
      { key: 'remote-access', title: '远程与手机访问', description: '连接开发机，理解分享链接与访问权限。' },
    ],
  },
  {
    label: '按需扩展',
    items: [
      { key: 'plugins', title: '插件与能力管理', description: '管理官方与用户插件，调整会话能力。' },
      { key: 'extensions', title: 'Skills、MCP 与角色', description: '复用工作方法，连接外部工具，定义工作方式。' },
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

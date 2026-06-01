import { MicaPlugin } from '../MicaPlugin';

const INIT_PROMPT = `请分析当前代码库并创建或更新 AGENTS.md 文件。AGENTS.md 会在每次 Mica Code 会话启动时注入 system prompt，因此内容必须简洁——只包含 AI 不知道会犯错的指令，同时包含足够的项目上下文让 AI 能高效工作。

你需要读取：
- package.json（scripts、workspaces、依赖）
- tsconfig.json（paths 别名、编译器选项）
- README.md / 现有的 AGENTS.md
- 构建脚本、测试/lint 配置
- 关键入口文件了解架构（src/index.ts、app 组件等）

重点发现以下非显而易见的坑：
1. 运行时/构建工具是否非标准（如用 bun 而非 node）
2. 是否存在 import 路径陷阱（如 workspace 包用别名、本地 fork 覆盖 npm 包）
3. 全局状态管理用什么方案（nanostores、zustand、context 等）
4. 是否存在禁止使用的 API（如禁止 console.log、禁止直接写 stderr）
5. 环境变量是否必需、API endpoint 默认值是否非标准
6. 项目特有的自引用行为（如配置文件被注入到 system prompt）
7. 插件的注册方式和顺序是否敏感

写入 AGENTS.md 时遵循以下规则：
- 每条内容都必须通过这个测试："去掉这行 AI 会犯错吗？"，不能通过就删掉
- 不要重复 README 中已有的显而易见的内容（如安装步骤、技术栈列表）
- 不要包含通用开发实践建议
- 使用简洁的要点列表，每条一行
- 不要编造"常见开发任务"、"开发技巧"等 README 中没有的章节
- 如果已有 AGENTS.md，提出改进建议而非直接覆盖

正确示例：
\`\`\`
- 使用 bun 而非 npm
- 禁止使用 console.log
- ink 组件从 @anthropic/ink 导入，不是 ink（本地 workspace 包，tsconfig paths 别名）
- AGENTS.md 在启动时自动注入 system prompt，编辑此文件直接影响 agent 行为
\`\`\``;

export class QuickCommandInitPlugin extends MicaPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'init',
      description: '分析代码库并创建/更新 AGENTS.md 文件',
      action: () => {
        this.agent.ui.TerminalInput.submit(INIT_PROMPT);
        this.showMessage('正在分析代码库...');
      },
    });
  }
}

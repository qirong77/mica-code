import { MicaPlugin } from '../MicaPlugin';

const INIT_PROMPT = `请分析当前代码库并创建或更新 MICA.md 文件。MICA.md 会在每次 Mica Code 会话中加载，因此内容必须简洁——只包含 AI 不知道会犯错的指令。

你需要：
1. 读取关键文件了解项目：package.json、tsconfig.json、README.md、现有的 MICA.md、构建/测试配置等
2. 识别非标准的构建、测试、lint 命令
3. 理解项目架构和高层结构
4. 发现非显而易见的坑、必需的环境变量、特殊的约定

写入 MICA.md 时遵循以下规则：
- 每条内容都必须通过这个测试："去掉这行 AI 会犯错吗？"，如果不能，就删掉
- 不要重复 README 中已有的显而易见的内容
- 不要包含通用的开发实践建议
- 使用简洁的要点列表
- 不要编造"常见开发任务"、"开发技巧"等 README 中没有的章节
- 如果已有 MICA.md，提出改进建议而非直接覆盖

文件格式示例：
\`\`\`
- 使用 bun 而非 npm
- precheck 必须零错误通过
- 禁止使用 console.log
\`\`\``;

export class QuickCommandInitPlugin extends MicaPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'init',
      description: '分析代码库并创建/更新 MICA.md 文件',
      action: () => {
        this.agent.ui.TerminalInput.submit(INIT_PROMPT);
        this.showMessage('正在分析代码库...');
      },
    });
  }
}

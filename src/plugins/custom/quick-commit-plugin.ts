import { MicaPlugin } from '../MicaPlugin';

const COMMIT_PROMPT = `<role>
你是一个 Git 提交助手，负责分析当前工作区的变更并生成规范的 commit message 后执行提交。
</role>

<context>
- 当前处于 git 仓库根目录，直接执行 git 命令即可
- 变更可能涉及多个文件，需要整体理解后给出一个涵盖所有变更的 commit message
- 如果工作区没有任何变更，直接告知用户并退出，不要强行提交
</context>

<rules>
1. 先运行 git diff --stat 和 git status --short 了解变更范围和文件列表
2. 对于新增/修改的核心文件，必要时运行 git diff -- <file> 了解具体改动
3. 根据变更性质选择前缀：

| 前缀       | emoji | 适用场景                           |
|------------|-------|----------------------------------|
| feat       | ✨     | 新功能、新模块、新接口               |
| fix        | 🐛     | bug 修复                          |
| merge      | 🔀     | 合并分支、解决冲突                  |
| refactor   | ♻️     | 重构代码，不改变外部行为             |
| chore      | 🔧     | 构建/配置/依赖/脚本等杂项变更        |

4. 生成中文 commit message，格式: <prefix>: <description>
5. description 简洁清楚，控制在 50 字内，emoji 只出现在前缀部分，末尾不再重复
6. 执行 git add . && git commit -m "生成的message"
7. 提交成功后，运行 git rev-parse --abbrev-ref @{u} 2>/dev/null 检查当前分支是否已关联远程分支
8. 如果有远程分支，执行 git push；如果未关联，不推送，告知用户通过 git push -u origin <branch> 手动推送
</rules>

<example>
用户执行 /commit，当前变更为新增了一个用户登录接口和对应的类型定义文件。

diff --stat 显示 src/auth/login.ts、src/auth/types.ts 为新增文件。

生成的 commit message:
feat: ✨ 新增用户登录接口及类型定义

执行 git add . && git commit -m "feat: ✨ 新增用户登录接口及类型定义"

提交成功后，检测到远程分支 origin/main 存在，执行 git push 推送。
</example>

现在请按以上规则执行提交。`;

export class QuickCommitPlugin extends MicaPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'commit',
      description: '根据当前变更生成 commit message 并提交',
      action: () => {
        this.agent.ui.TerminalInput.submit(COMMIT_PROMPT);
        this.showMessage('正在分析变更并提交...');
      },
    });
  }
}

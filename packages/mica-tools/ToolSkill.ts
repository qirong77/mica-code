import { MicaTool, type ToolExecuteCallbacks } from './MicaTool.js';
import { micaSkills, type Skill } from '@packages/mica-skills/index.js';

function findSkill(name: string): Skill | undefined {
  return micaSkills.getLoaded().find((skill) => skill.name === name || skill.name === name.replace(/^\//, ''));
}

function substituteArgs(content: string, args: string | undefined, skill: Skill): string {
  let result = [
    `<skill-instructions name="${skill.name}">`,
    `Base directory for this skill: ${skill.baseDir}`,
    '',
    content,
  ].join('\n');

  if (args) {
    const tokens = args.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const argNames = tokens.map((token) => token.replace(/^"|"$/g, ''));
    const dollarVarMatch = content.match(/\$(\w+)/g);
    if (dollarVarMatch) {
      const varNames = [...new Set(dollarVarMatch.map((value) => value.slice(1)))];
      for (let i = 0; i < Math.min(varNames.length, argNames.length); i++) {
        result = result.replace(new RegExp(`\\$${varNames[i]}`, 'g'), argNames[i]);
      }
    }
    result += `\n\nArguments provided: ${args}`;
  }

  return `${result}\n</skill-instructions>`;
}

export class ToolSkill extends MicaTool {
  constructor() {
    super(
      'skill',
      'Invoke a skill by name',
      {
        type: 'object',
        properties: {
          skill: {
            type: 'string',
            description: 'The skill name. E.g. "commit", "pdf", or "review-pr".',
          },
          args: {
            type: 'string',
            description: 'Optional arguments for the skill',
          },
        },
        required: ['skill'],
      },
      { readOnly: true },
    );
  }

  async execute(input: Record<string, unknown>, callbacks?: ToolExecuteCallbacks): Promise<string> {
    const skillName = String(input.skill ?? '').trim();
    if (!skillName) return '错误：缺少 skill 名称';

    const skill = findSkill(skillName);
    if (!skill) {
      const available = micaSkills
        .getLoaded()
        .map((entry) => entry.name)
        .join(', ');
      return `未知 skill: ${skillName}\n可用的 skills: ${available || '无'}`;
    }

    // 会话可以关掉部分 skill。索引里已经没有它，但模型仍可能凭记忆点名调用，
    // 这里按同一份开关拒绝，避免「看不见却能加载」。
    const disabledSkills = (callbacks?.context as { agent?: { capabilitySelection?: { disabledSkills?: string[] } } })
      ?.agent?.capabilitySelection?.disabledSkills;
    if (disabledSkills?.includes(skill.name)) {
      return `skill 已被当前会话关闭: ${skill.name}`;
    }

    return substituteArgs(skill.content, typeof input.args === 'string' ? input.args : undefined, skill);
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    return `调用 skill: ${String(input.skill ?? '')}`;
  }
}

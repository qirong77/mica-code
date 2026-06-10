import { MicaTool, type ToolExecuteCallbacks } from './MicaTool'
import { getLoadedSkills } from '../skills/loadSkills'
import type { Skill } from '../skills/types'

function findSkill(name: string): Skill | undefined {
  return getLoadedSkills().find(
    (s) => s.name === name || s.name === name.replace(/^\//, ''),
  )
}

function substituteArgs(content: string, args: string | undefined, skill: Skill): string {
  let result = `Base directory for this skill: ${skill.baseDir}\n\n${content}`

  if (args) {
    const tokens = args.match(/(?:[^\s"]+|"[^"]*")+/g) || []
    const argNames = tokens.map((t) => t.replace(/^"|"$/g, ''))

    const dollarVarMatch = content.match(/\$(\w+)/g)
    if (dollarVarMatch) {
      const varNames = [...new Set(dollarVarMatch.map((v) => v.slice(1)))]
      for (let i = 0; i < Math.min(varNames.length, argNames.length); i++) {
        result = result.replace(new RegExp(`\\$${varNames[i]}`, 'g'), argNames[i])
      }
    }

    result += `\n\nArguments provided: ${args}`
  }

  return result
}

export class ToolSkill extends MicaTool {
  constructor() {
    super('Skill', 'Invoke a skill by name', {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description:
            'The skill name. E.g., "commit", "review-pr", or "pdf"',
        },
        args: {
          type: 'string',
          description: 'Optional arguments for the skill',
        },
      },
      required: ['skill'],
    })
  }

  async execute(
    input: Record<string, any>,
    _callbacks?: ToolExecuteCallbacks,
  ): Promise<string> {
    const skillName = String(input.skill ?? '').trim()
    if (!skillName) return '错误：缺少 skill 名称'

    const skill = findSkill(skillName)
    if (!skill) {
      const available = getLoadedSkills()
        .map((s) => s.name)
        .join(', ')
      return `未知 skill: ${skillName}\n可用的 skills: ${available || '无'}`
    }

    const content = substituteArgs(skill.content, input.args as string | undefined, skill)
    return content
  }

  onToolUseDisplayText(input: Record<string, any>): string {
    return `调用 skill: ${input.skill}`
  }

  
}

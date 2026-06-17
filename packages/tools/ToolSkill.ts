import { MicaTool, type ToolExecuteCallbacks } from "./MicaTool";
import { getLoadedSkills } from "../../src/skills/loadSkills";
import type { Skill } from "../../src/skills/types";

function findSkill(name: string): Skill | undefined {
  return getLoadedSkills().find(
    (skill) => skill.name === name || skill.name === name.replace(/^\//, ""),
  );
}

function substituteArgs(
  content: string,
  args: string | undefined,
  skill: Skill,
): string {
  let result = [
    `<skill-instructions name="${skill.name}">`,
    `Base directory for this skill: ${skill.baseDir}`,
    "",
    content,
  ].join("\n");

  if (args) {
    const tokens = args.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const argNames = tokens.map((token) => token.replace(/^"|"$/g, ""));
    const dollarVarMatch = content.match(/\$(\w+)/g);
    if (dollarVarMatch) {
      const varNames = [...new Set(dollarVarMatch.map((value) => value.slice(1)))];
      for (let i = 0; i < Math.min(varNames.length, argNames.length); i++) {
        result = result.replace(new RegExp(`\\$${varNames[i]}`, "g"), argNames[i]);
      }
    }
    result += `\n\nArguments provided: ${args}`;
  }

  return `${result}\n</skill-instructions>`;
}

export class ToolSkill extends MicaTool {
  constructor() {
    super("Skill", "Invoke a skill by name", {
      type: "object",
      properties: {
        skill: {
          type: "string",
          description: 'The skill name. E.g. "commit", "pdf", or "review-pr".',
        },
        args: {
          type: "string",
          description: "Optional arguments for the skill",
        },
      },
      required: ["skill"],
    });
  }

  async execute(
    input: Record<string, any>,
    _callbacks?: ToolExecuteCallbacks,
  ): Promise<string> {
    const skillName = String(input.skill ?? "").trim();
    if (!skillName) return "错误：缺少 skill 名称";

    const skill = findSkill(skillName);
    if (!skill) {
      const available = getLoadedSkills()
        .map((entry) => entry.name)
        .join(", ");
      return `未知 skill: ${skillName}\n可用的 skills: ${available || "无"}`;
    }

    return substituteArgs(skill.content, input.args as string | undefined, skill);
  }

  onToolUseDisplayText(input: Record<string, any>): string {
    return `调用 skill: ${String(input.skill ?? "")}`;
  }
}

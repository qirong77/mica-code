import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { micaSkills, type Skill } from '@packages/mica-skills/index.js';
import DEFAULT_SYSTEM_PROMPT from './system.md' with { type: 'text' };

type PromptSection = 'system' | 'project-instructions' | 'context' | 'skills';

const PROJECT_INSTRUCTIONS_PATH = join(process.cwd(), 'AGENT.md');

export type BuildSystemPromptOptions = {
  cwd?: string;
  now?: Date;
  platform?: NodeJS.Platform;
  shell?: string;
  projectInstructions?: string | null;
  skills?: Skill[];
};

class SystemPromptBuilder {
  private prompt = '';

  constructor(options: BuildSystemPromptOptions = {}) {
    this.prompt = wrapSection('system', DEFAULT_SYSTEM_PROMPT);

    const projectInstructions =
      options.projectInstructions === undefined
        ? readOptionalText(PROJECT_INSTRUCTIONS_PATH)
        : (options.projectInstructions ?? undefined);
    if (projectInstructions) {
      this.append('project-instructions', projectInstructions);
    }

    const skills = [...(options.skills ?? micaSkills.getLoaded())].sort((a, b) => a.name.localeCompare(b.name));
    if (skills.length > 0) {
      const listing = skills
        .map((skill) =>
          [
            `- ${skill.name}: ${skill.description}`,
            skill.whenToUse ? `  when_to_use: ${skill.whenToUse}` : '',
            skill.argumentHint ? `  argument_hint: ${skill.argumentHint}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        )
        .join('\n');
      this.append(
        'skills',
        `可用 skills 索引如下。这里只是索引；需要使用时通过 Skill 工具读取完整说明。\n\n${listing}`,
      );
    }

    this.append('context', buildContextBlock(options));
  }

  append(section: PromptSection, content: string) {
    const trimmed = content.trim();
    if (!trimmed) return this;
    this.prompt += `\n\n${wrapSection(section, trimmed)}`;
    return this;
  }

  get value() {
    return this.prompt;
  }
}

export function buildSystemPrompt(): string {
  return new SystemPromptBuilder().value;
}

export function buildSystemPromptForTest(options: BuildSystemPromptOptions): string {
  return new SystemPromptBuilder(options).value;
}

function wrapSection(section: PromptSection, content: string): string {
  return `<${section}>\n${content}\n</${section}>`;
}

function readOptionalText(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf-8').trim();
  return text.length > 0 ? text : undefined;
}

function buildContextBlock(options: BuildSystemPromptOptions = {}): string {
  const now = options.now ?? new Date();
  return [
    `# 环境信息`,
    `- 当前工作目录: ${options.cwd ?? process.cwd()}`,
    `- 当前时间: ${formatCurrentMonth(now)}`,
    `- 操作系统: ${options.platform ?? process.platform}`,
    `- Shell: ${options.shell ?? process.env.SHELL ?? 'unknown'}`,
  ].join('\n');
}

function formatCurrentMonth(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

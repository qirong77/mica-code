import { escapePromptXml, wrapPromptXml } from '@packages/mica-common/promptXml.js';
import { orderPromptSections, type PromptControls, type PromptSectionSnapshot } from '@packages/mica-common/promptControls.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { micaSkills, type Skill } from '@packages/mica-skills/index.js';
import DEFAULT_SYSTEM_PROMPT from './system.md' with { type: 'text' };
import { applyBrandTemplate } from './brandTemplate.js';

export { DEFAULT_ROLE_NAME, getAgentRole, getRolesDirectory, listAgentRoles } from './roles.js';
export type { AgentRole } from './roles.js';

type PromptSection = 'system' | 'role' | 'project-instructions' | 'context' | 'skills';

const PROJECT_INSTRUCTION_FILES = ['AGENT.md', 'AGENTS.md'] as const;

export type BuildSystemPromptOptions = {
  /** 追加在内置 `<system>` 后面的 `<role>` 正文，同属系统提示词。 */
  rolePrompt?: string;
  cwd?: string;
  now?: Date;
  platform?: NodeJS.Platform;
  shell?: string;
  projectInstructions?: string | null;
  skills?: Skill[];
  promptControls?: PromptControls;
};

class SystemPromptBuilder {
  readonly sections: PromptSectionSnapshot[] = [];
  private readonly order: string[] | undefined;

  constructor(options: BuildSystemPromptOptions = {}) {
    this.order = options.promptControls?.order;
    this.append('system', applyBrandTemplate(DEFAULT_SYSTEM_PROMPT), options.promptControls);
    this.append(
      'role',
      options.rolePrompt?.trim() ? applyBrandTemplate(options.rolePrompt) : '',
      options.promptControls,
    );

    const projectInstructions =
      options.projectInstructions === undefined
        ? readProjectInstructions(options.cwd ?? process.cwd())
        : (options.projectInstructions ?? undefined);
    this.append('project-instructions', projectInstructions ?? '', options.promptControls);

    const skills = options.skills ?? micaSkills.getLoaded();
    this.append(
      'skills',
      skills.length > 0
        ? `可用 skills 索引如下。这里只是索引；需要使用时通过 \`skill\` 工具读取完整说明。\n\n${formatSkillsIndex(skills)}`
        : '',
      options.promptControls,
    );

    this.append('context', buildContextBlock(options), options.promptControls);
  }

  append(section: PromptSection, content: string, controls?: PromptControls) {
    const originalContent = content.trim();
    const editable = section !== 'system';
    const override = editable ? controls?.sections[section] : undefined;
    this.sections.push({
      id: section,
      label: section,
      originalContent,
      content: (override?.content ?? originalContent).trim(),
      enabled: !editable || override?.enabled !== false,
      editable,
    });
    return this;
  }

  get value() {
    return orderPromptSections(this.sections, this.order)
      .filter((section) => section.enabled && section.content)
      .map((section) => wrapSection(section.id as PromptSection, section.content))
      .join('\n\n');
  }
}

export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
  return inspectSystemPrompt(options).prompt;
}

/** Build the preview and its source sections in a single pass. */
export function inspectSystemPrompt(options: BuildSystemPromptOptions = {}): {
  prompt: string;
  sections: PromptSectionSnapshot[];
} {
  const builder = new SystemPromptBuilder(options);
  // 对外暴露的快照与拼装结果同序，界面上的排列就是这一轮真正的排列。
  return { prompt: builder.value, sections: orderPromptSections(builder.sections, options.promptControls?.order) };
}

/**
 * skills 索引正文（不含 `<skills>` 包裹）。
 *
 * By The Way 的隔离子代理要拿到与主流程一致的 skills 索引（它替换了系统提示词，
 * 否则模型不知道有哪些 skill 可用），所以这段必须只有一份实现。
 */
export function formatSkillsIndex(skills: Skill[] = micaSkills.getLoaded()): string {
  return [...skills]
    .sort((a, b) => a.name.localeCompare(b.name))
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
}

function wrapSection(section: PromptSection, content: string): string {
  return wrapPromptXml(section, content);
}

function readOptionalText(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf-8').trim();
  return text.length > 0 ? text : undefined;
}

export function readProjectInstructions(cwd = process.cwd()): string | undefined {
  const found = PROJECT_INSTRUCTION_FILES.flatMap((name) => {
    const content = readOptionalText(join(cwd, name));
    return content ? [{ name, content }] : [];
  });
  if (found.length === 0) return undefined;
  return found
    .map(({ name, content }) => wrapPromptXml('document', escapePromptXml(content), { source: name }))
    .join('\n\n');
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

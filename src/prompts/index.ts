import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { SystemPromptBuilder } from './buildSystemPrompt';
import systemPromptMd from './system.md';
import { getLoadedSkills } from '../skills/loadSkills';

const PLAN_REMINDER =
  '当前处于 plan mode，仅分析规划，不要执行代码修改等编辑操作。（除非用户明确提成执行你给出的规划，你才可以执行代码修改等编辑操作）';

const builder = new SystemPromptBuilder();
builder.append('system', systemPromptMd);

const skills = getLoadedSkills();
if (skills.length > 0) {
  const skillsListing = skills
    .map((s) => {
      const desc = s.whenToUse
        ? `${s.description} — ${s.whenToUse}`
        : s.description
      return `- **${s.name}**: ${desc}`
    })
    .join('\n')
  builder.append(
    'skills',
    `You have access to the following skills. Invoke them via the Skill tool when relevant:\n\n${skillsListing}`,
  )
}

const micaMdPath = join(process.cwd(), 'AGENTS.md');
const micaMdContent = existsSync(micaMdPath) ? readFileSync(micaMdPath, 'utf-8') : null;

if (micaMdContent) {
  builder.append('project-instructions', micaMdContent);
}

export const systemPrompt = builder.prompt;
export const planModePrompt = builder.withReminder(PLAN_REMINDER);

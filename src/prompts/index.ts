import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { SystemPromptBuilder } from './buildSystemPrompt.js';
import systemPromptMd from './system.md';
import { getLoadedSkills } from '../skills/loadSkills.js';

export const promptBuilder = new SystemPromptBuilder();
promptBuilder.append('system', systemPromptMd);

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
  promptBuilder.append(
    'skills',
    `You have access to the following skills. Invoke them via the Skill tool when relevant:\n\n${skillsListing}`,
  )
}

const micaMdPath = join(process.cwd(), 'AGENTS.md');
const micaMdContent = existsSync(micaMdPath) ? readFileSync(micaMdPath, 'utf-8') : null;

if (micaMdContent) {
  promptBuilder.append('project-instructions', micaMdContent);
}

export function getSystemPrompt(): string {
  return promptBuilder.prompt;
}



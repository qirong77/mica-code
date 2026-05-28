import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { SystemPromptBuilder } from './buildSystemPrompt';

const builder = new SystemPromptBuilder();

const micaMdPath = join(process.cwd(), 'MICA.md');
const micaMdContent = existsSync(micaMdPath) ? readFileSync(micaMdPath, 'utf-8') : null;

if (micaMdContent) {
  builder.append('project-instructions', micaMdContent);
}

export const systemPrompt = builder.prompt;

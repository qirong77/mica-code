import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { SystemPromptBuilder } from './buildSystemPrompt';
import systemPromptMd from './system.md';

const builder = new SystemPromptBuilder();
builder.append('system', systemPromptMd);
const micaMdPath = join(process.cwd(), 'MICA.md');
const micaMdContent = existsSync(micaMdPath) ? readFileSync(micaMdPath, 'utf-8') : null;

if (micaMdContent) {
  builder.append('project-instructions', micaMdContent);
}

export const systemPrompt = builder.prompt;

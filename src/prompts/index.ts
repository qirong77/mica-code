import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import template from './system.md';

const systemContent = template
  .replace('{{cwd}}', process.cwd())
  .replace('{{date}}', new Date().toLocaleDateString())
  .replace('{{platform}}', process.platform)
  .replace('{{shell}}', process.env.SHELL || 'unknown');

const micaMdPath = join(process.cwd(), 'MICA.md');
const micaMdContent = existsSync(micaMdPath) ? readFileSync(micaMdPath, 'utf-8') : null;

let systemPrompt = `<system>\n${systemContent}\n</system>`;

if (micaMdContent) {
  systemPrompt += `\n\n<project-instructions>\n${micaMdContent}\n</project-instructions>`;
}

export { systemPrompt };

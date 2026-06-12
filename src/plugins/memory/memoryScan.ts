import { readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import type { MemoryType } from './memoryTypes.js';
import { parseMemoryType } from './memoryTypes.js';

export interface MemoryHeader {
  filename: string;
  filePath: string;
  mtimeMs: number;
  description: string | null;
  type: MemoryType | undefined;
}

const MAX_MEMORY_FILES = 200;
const FRONTMATTER_MAX_LINES = 30;

function parseFrontmatterDescription(content: string): string | null {
  const lines = content.split('\n');
  let inFrontmatter = false;
  for (let i = 0; i < Math.min(lines.length, FRONTMATTER_MAX_LINES); i++) {
    const line = lines[i].trim();
    if (i === 0 && line === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter && line === '---') break;
    if (inFrontmatter) {
      const descMatch = line.match(/^description:\s*(.+)$/);
      if (descMatch) return descMatch[1].trim();
      const typeMatch = line.match(/^type:\s*(.+)$/);
    }
  }
  return null;
}

function parseFrontmatterType(content: string): MemoryType | undefined {
  const lines = content.split('\n');
  let inFrontmatter = false;
  for (let i = 0; i < Math.min(lines.length, FRONTMATTER_MAX_LINES); i++) {
    const line = lines[i].trim();
    if (i === 0 && line === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter && line === '---') break;
    if (inFrontmatter) {
      const typeMatch = line.match(/^type:\s*(.+)$/);
      if (typeMatch) return parseMemoryType(typeMatch[1].trim());
    }
  }
  return undefined;
}

export function scanMemoryFiles(memoryDir: string): MemoryHeader[] {
  try {
    const entries = readdirSync(memoryDir, { recursive: true }) as string[];
    const mdFiles = entries
      .filter(f => f.endsWith('.md') && basename(f) !== 'MEMORY.md');

    const headers: MemoryHeader[] = [];
    for (const relativePath of mdFiles) {
      try {
        const filePath = join(memoryDir, relativePath);
        const stat = statSync(filePath);
        const content = readFileSync(filePath, 'utf-8');
        headers.push({
          filename: relativePath,
          filePath,
          mtimeMs: stat.mtimeMs,
          description: parseFrontmatterDescription(content),
          type: parseFrontmatterType(content),
        });
      } catch {
        // skip unreadable files
      }
    }

    return headers
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_MEMORY_FILES);
  } catch {
    return [];
  }
}

export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories
    .map(m => {
      const tag = m.type ? `[${m.type}] ` : '';
      const ts = new Date(m.mtimeMs).toISOString();
      return m.description
        ? `- ${tag}${m.filename} (${ts}): ${m.description}`
        : `- ${tag}${m.filename} (${ts})`;
    })
    .join('\n');
}

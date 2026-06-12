import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { join, normalize } from 'path';
import { findGitRoot } from '../../utils/findGitRoot.js';

export function getMemoryBaseDir(): string {
  return join(homedir(), '.mica', 'memory');
}

export function getSessionMemoryDir(): string {
  return join(homedir(), '.mica', 'session-memory');
}

export function getProjectHash(): string {
  const root = findGitRoot(process.cwd()) ?? process.cwd();
  return createHash('sha256').update(root).digest('hex').slice(0, 16);
}

export function getMemoryDir(): string {
  return join(getMemoryBaseDir(), getProjectHash());
}

export function getMemoryIndexPath(): string {
  return join(getMemoryDir(), 'MEMORY.md');
}

export function getSessionMemoryPath(sessionId: string): string {
  return join(getSessionMemoryDir(), `${sessionId}.md`);
}

export function isMemoryPath(filePath: string): boolean {
  const normalized = normalize(filePath);
  return normalized.startsWith(getMemoryDir());
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function ensureMemoryDir(): void {
  ensureDir(getMemoryDir());
}

export function ensureSessionMemoryDir(): void {
  ensureDir(getSessionMemoryDir());
}

export function readMemoryIndex(): string {
  const indexPath = getMemoryIndexPath();
  try {
    return readFileSync(indexPath, 'utf-8');
  } catch {
    return '';
  }
}

export function writeMemoryIndex(content: string): void {
  ensureMemoryDir();
  writeFileSync(getMemoryIndexPath(), content, { encoding: 'utf-8', mode: 0o600 });
}

export function readSessionMemory(sessionId: string): string | null {
  const path = getSessionMemoryPath(sessionId);
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

export function writeSessionMemory(sessionId: string, content: string): void {
  ensureSessionMemoryDir();
  writeFileSync(getSessionMemoryPath(sessionId), content, { encoding: 'utf-8', mode: 0o600 });
}

export function listMemoryFiles(): string[] {
  const dir = getMemoryDir();
  try {
    return (readdirSync(dir, { recursive: true }) as string[])
      .filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
  } catch {
    return [];
  }
}

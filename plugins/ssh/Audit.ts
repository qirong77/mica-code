import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 审计日志：`$MICA_HOME/plugin-data/ssh/audit.jsonl`。
 *
 * 分布式系统里最贵的事故是「谁在什么时候改了什么」，而模型发起的命令最容易变成这种
 * 事故：它不会记得自己十分钟前 `rm` 过什么。所以每条命令都留一行——主机、脚本首行、
 * 退出码、耗时。**不记输出正文**（可能带凭据、可能几十 MB），只在输出被裁剪时记路径。
 *
 * 只追加、只保留最近 N 条：面板要翻的是「刚刚发生了什么」，不是归档。
 */

export const AUDIT_FILE = 'audit.jsonl';
const KEEP = 200;
const MAX_SCRIPT = 400;

export type AuditEntry = {
  at: string;
  hostId: string;
  target: string;
  source: 'run' | 'read' | 'session' | 'panel';
  script: string;
  exitCode: number | null;
  durationMs: number;
  ok: boolean;
  /** 输出被裁剪时远端完整日志的路径。 */
  logPath?: string;
  note?: string;
};

function clip(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

export function appendAudit(dataDir: string, entry: AuditEntry): void {
  const file = join(dataDir, AUDIT_FILE);
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ ...entry, script: clip(entry.script, MAX_SCRIPT) })}\n`, 'utf8');
  } catch {
    // 记不上日志不该让那次远程操作失败。
  }
  trimAudit(file);
}

function trimAudit(file: string): void {
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= KEEP) return;
    writeFileSync(file, `${lines.slice(-KEEP).join('\n')}\n`, 'utf8');
  } catch {
    // 同上：日志维护失败不影响功能。
  }
}

export function readAudit(dataDir: string, limit = 20): AuditEntry[] {
  try {
    const lines = readFileSync(join(dataDir, AUDIT_FILE), 'utf8').split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as AuditEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is AuditEntry => entry !== null)
      .reverse();
  } catch {
    return [];
  }
}

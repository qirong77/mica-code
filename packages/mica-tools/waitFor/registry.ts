import crypto from 'node:crypto';
import type { NormalizedWaitCondition, WaitKind } from './types.js';

export type WaitTaskStatus = 'waiting' | 'parked' | 'satisfied' | 'timeout' | 'aborted';

export type WaitRecord = {
  id: string;
  kind: WaitKind;
  /** 短的、人读的条件标签（工具展示与桌面端 dock 共用）。 */
  label: string;
  condition: NormalizedWaitCondition;
  /** 只在进程内存在的轮询基线：`changed`/`stdout_changed`/`body_changed` 第一次观察到的值。 */
  baseline: Record<string, unknown>;
  createdAt: number;
  deadline: number;
  pollIntervalMs: number;
  polls: number;
  status: WaitTaskStatus;
  /** 最近一次观测到的事实（成功或失败都更新）。 */
  detail?: string;
  /** 最近一次轮询本身的错误（连不上、命令起不来…），不等于条件失败。 */
  error?: string;
  finishedAt?: number;
};

const MAX_RECORDS = 64;
const TERMINAL_TTL_MS = 5 * 60_000;
/**
 * `background: true` 只登记不轮询，条件没人推进时它永远停在 `parked`。
 * 超过这个时间就当作已被遗忘的等待丢掉（dock 行与基线一起清），
 * 否则没有进程再会去结算它，dock 上会挂一条永不消失的行。
 */
const PARKED_TTL_MS = 2 * 60 * 60_000;

const records = new Map<string, WaitRecord>();

/**
 * 仍在等待的记录（dock 与任务快照只认这两个状态）。
 * `timeout` 刻意不算「仍在等待」——那一刻确实没人在等了；模型带着同一个
 * wait_id 续等时它会重新回到 waiting。
 */
export function isActiveWaitStatus(status: WaitTaskStatus): boolean {
  return status === 'waiting' || status === 'parked';
}

/** 可以再次等待的记录：只有已经满足的才算彻底结束（续等会直接返回 satisfied）。 */
export function isResumableWaitStatus(status: WaitTaskStatus): boolean {
  return status !== 'satisfied';
}

/** 淘汰过期的终态记录并给总条数封顶，避免长会话里记录无限增长。 */
export function pruneWaitRecords(now = Date.now()): void {
  for (const record of records.values()) {
    // deadline 在每次续等时都会刷新，所以这是「最后一次被碰过之后」的时间。
    if (record.status === 'parked' && now - record.deadline > PARKED_TTL_MS) {
      records.delete(record.id);
      continue;
    }
    if (
      !isActiveWaitStatus(record.status) &&
      record.finishedAt !== undefined &&
      now - record.finishedAt > TERMINAL_TTL_MS
    ) {
      records.delete(record.id);
    }
  }
  if (records.size < MAX_RECORDS) return;
  const order = [...records.values()].sort((a, b) => {
    const terminalA = isActiveWaitStatus(a.status) ? 0 : 1;
    const terminalB = isActiveWaitStatus(b.status) ? 0 : 1;
    if (terminalA !== terminalB) return terminalB - terminalA;
    return (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt);
  });
  for (const record of order) {
    if (records.size < MAX_RECORDS) break;
    if (isActiveWaitStatus(record.status)) break;
    records.delete(record.id);
  }
}

export function createWaitRecord(params: {
  kind: WaitKind;
  label: string;
  condition: NormalizedWaitCondition;
  pollIntervalMs: number;
  timeoutMs: number;
  status: WaitTaskStatus;
}): WaitRecord {
  pruneWaitRecords();
  const now = Date.now();
  const record: WaitRecord = {
    id: crypto.randomBytes(4).toString('hex'),
    kind: params.kind,
    label: params.label,
    condition: params.condition,
    baseline: {},
    createdAt: now,
    deadline: now + params.timeoutMs,
    pollIntervalMs: params.pollIntervalMs,
    polls: 0,
    status: params.status,
  };
  records.set(record.id, record);
  return record;
}

export function getWaitRecord(id: string): WaitRecord | undefined {
  return records.get(id);
}

export function settleWaitRecord(record: WaitRecord, status: WaitTaskStatus, detail?: string): void {
  record.status = status;
  record.finishedAt = Date.now();
  if (detail !== undefined) record.detail = detail;
}

export function listWaitRecords(): WaitRecord[] {
  pruneWaitRecords();
  return [...records.values()].sort((a, b) => a.createdAt - b.createdAt);
}

/** 只暴露还在等待的记录，供 app-server 的任务快照投影使用。 */
export function listActiveWaits(): WaitRecord[] {
  return listWaitRecords().filter((record) => isActiveWaitStatus(record.status));
}

/** 测试与进程收尾用。 */
export function clearWaitRecords(): void {
  records.clear();
}

export function removeWaitRecord(id: string): boolean {
  return records.delete(id);
}

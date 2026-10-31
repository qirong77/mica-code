import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { resolveMicaHomePath } from '@packages/mica-config/index.js';
import type { UsageLedgerEntry } from '@packages/mica-web-shared/usage-ledger.js';
import type { AgentUsageRecord } from '@packages/mica-agent/index.js';

/**
 * 无会话的模型请求记账：`mica commit` 这类一次性命令没有会话可写，用量追加进
 * `$MICA_HOME/usage-ledger.jsonl`，桌面统计页读取它并进总量（形状与解析在
 * `mica-web-shared/usage-ledger`）。
 *
 * 为什么不写回会话文件：一次性命令跑在另一个进程里，会话文件此刻可能正被常驻宿主
 * 持有（turn lease），跨进程改写快照既没有锁也没有冲突处理——那会变成「统计把用户
 * 的对话写坏」。账本是只追加的独立文件，两边都不碰对方的数据。
 */

export const USAGE_LEDGER_FILE = 'usage-ledger.jsonl';
/** 账本只追加，超过这个大小就从最早的行开始丢：它只服务统计，不需要留完整历史。 */
const MAX_LEDGER_BYTES = 4 * 1024 * 1024;

export function usageLedgerPath(): string {
  return resolveMicaHomePath(USAGE_LEDGER_FILE);
}

export type UsageLedgerAppendOptions = {
  pluginId: string;
  purpose: string | null;
  cwd: string | null;
  requests: AgentUsageRecord[];
  /** 请求没有 `occurredAt` 时的兜底时间（老 provider / 测试）。 */
  fallbackAt?: string;
  path?: string;
};

/** 把一次插件请求的用量追加进账本（每条请求一行，`id` 为 usageId 或内容摘要）。 */
export function appendPluginUsage(options: UsageLedgerAppendOptions): number {
  const entries: UsageLedgerEntry[] = [];
  for (const usage of options.requests) {
    const occurredAt = usage.occurredAt || options.fallbackAt;
    if (!occurredAt) continue;
    entries.push({
      id: usage.usageId || randomUUID(),
      occurredAt,
      model: usage.model || 'Unknown',
      pluginId: options.pluginId,
      purpose: options.purpose,
      cwd: options.cwd,
      inputTokens: usage.inputTokens ?? 0,
      cachedInputTokens: usage.cachedInputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    });
  }
  if (entries.length === 0) return 0;
  const path = options.path || usageLedgerPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    trimLedger(path);
    appendFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf-8');
    return entries.length;
  } catch {
    // 记账失败不能让一次已经付过钱的命令报错：用量丢一条比命令失败好。
    return 0;
  }
}

/** 账本超过上限时保留尾部若干行（整份重写，只会在追加前发生一次）。 */
function trimLedger(path: string): void {
  if (!existsSync(path)) return;
  if (statSync(path).size <= MAX_LEDGER_BYTES) return;
  const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
  const kept = lines.slice(-Math.floor(lines.length / 2));
  writeFileSync(path, kept.length ? `${kept.join('\n')}\n` : '', 'utf-8');
}

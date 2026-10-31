// 无会话的模型请求账本：`mica commit` 这类一次性插件命令没有会话可写，用量记进
// `$MICA_HOME/usage-ledger.jsonl`，统计页把它当成一批「没有会话归属」的用量并进总量。
// 写入方（CLI）与读取方（desktop host）共用这一份形状与解析。

export type UsageLedgerEntry = {
  /** 请求级唯一 id（`usageId`），跨进程重复写入时用来去重。 */
  id: string;
  occurredAt: string;
  model: string;
  pluginId: string;
  /** 这笔请求是干什么的（插件自己给的 purpose）。 */
  purpose: string | null;
  /** 发起时的工作目录：统计页按项目归档时要用。 */
  cwd: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function count(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** 解析账本文本：坏行跳过（写一半的追加、手改过的文件都不能让统计整份失败）。 */
export function parseUsageLedger(content: string): UsageLedgerEntry[] {
  const entries: UsageLedgerEntry[] = [];
  const seen = new Set<string>();
  for (const line of String(content ?? '').split('\n')) {
    const raw = line.trim();
    if (!raw) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const id = text(parsed.id);
    const occurredAt = text(parsed.occurredAt);
    const model = text(parsed.model);
    const pluginId = text(parsed.pluginId);
    if (!id || !occurredAt || !model || !pluginId) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({
      id,
      occurredAt,
      model,
      pluginId,
      purpose: text(parsed.purpose),
      cwd: text(parsed.cwd),
      inputTokens: count(parsed.inputTokens),
      cachedInputTokens: count(parsed.cachedInputTokens),
      outputTokens: count(parsed.outputTokens),
    });
  }
  return entries;
}

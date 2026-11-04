/**
 * provider 原始 usage 的落盘形态。
 *
 * 有些网关（聚合网关尤其）会在 `usage` 里回传**逐条消息**的 token 归因
 * （`usage.attribution.items[*]`），单条记录能到 200KB 以上。它随会话快照整份读写、
 * 也随 `chat:history` / stats 扫描反复解析——实测单条会话因此从 1.5MB 涨到 30MB，
 * 其中 95% 是这份归因。
 *
 * 归因没有消费方（界面与统计只读 token 数字），但整份丢掉会让「这个网关到底怎么算的」
 * 无从查证，所以保留**一层标量**：顶层数字与 `*_details` 这类一层的子对象，丢掉数组与
 * 更深的结构，并留一个 `truncated` 说明这一份被裁过。
 */

const MAX_DETAIL_KEYS = 24;
const MAX_DETAIL_DEPTH = 2;

function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function compactValue(value: unknown, depth: number): unknown {
  if (isScalar(value)) {
    // 字符串也可能是大块（少见：某些网关把 token 明细写成 JSON 字符串）
    return typeof value === 'string' && value.length > 200 ? `${value.slice(0, 200)}…` : value;
  }
  if (depth >= MAX_DETAIL_DEPTH || !value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) return undefined;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length > MAX_DETAIL_KEYS) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const compacted = compactValue((value as Record<string, unknown>)[key], depth + 1);
    if (compacted !== undefined) out[key] = compacted;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 把一份 provider usage 压成「只有标量与一层明细」的形状。
 * 返回 `undefined` 表示这份原始数据没必要留（全是被裁掉的数组 / 嵌套）。
 */
export function compactRawUsage(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, unknown> = {};
  let dropped = false;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const compacted = compactValue(value, 0);
    if (compacted === undefined) {
      dropped = true;
      continue;
    }
    out[key] = compacted;
  }
  if (dropped) out.truncated = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

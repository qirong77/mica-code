/**
 * 桌面端「界面状态」在运行时与页面之间共用的纯逻辑。
 *
 * 单一实例架构下界面状态只有一份，放在运行时进程里（见 apps/desktop/src/host/ui-state.js）：
 * 页面提交补丁，运行时持久化后把变更广播给所有已连接页面。两侧必须对「键是否合法」
 * 「补丁怎么合并」「值有没有真的变」有一致的判断——各写一份就会分叉：一侧认为没有变化
 * 因此不广播，另一侧却在按新值重渲染。所以这些判定只保留这一份实现。
 */

/** 补丁来自页面、会被合并到普通对象上，这几个名字不能当键。 */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_KEY_LENGTH = 128;

export function isUiStateKey(key: unknown): key is string {
  return (
    typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY_LENGTH && !RESERVED_KEYS.has(key)
  );
}

/**
 * 值是否相等。补丁经过 JSON 往返，对象永远是新引用，只能按内容比；这里只服务于
 * 「有没有变化」这一个判断，值都很小（一两个数字、一小组草稿），比不出来时按
 * 「有变化」保守处理。
 */
export function uiStateValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * 把补丁合并到键值表上，`null`/`undefined` 表示删除该键。没有任何键真正变化时返回
 * `null`，调用方据此跳过广播与落盘（拖动分隔条、打字会产生大量空转补丁）。
 */
export function applyUiStatePatch(
  current: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null;
  const source = current && typeof current === 'object' ? current : {};
  let next: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(patch)) {
    if (!isUiStateKey(key)) continue;
    if (value === null || value === undefined) {
      if (!(key in source)) continue;
      next = next ?? { ...source };
      delete next[key];
      continue;
    }
    if (uiStateValuesEqual(source[key], value)) continue;
    next = next ?? { ...source };
    next[key] = value;
  }
  return next;
}

/**
 * 两个键值表之间真正变化的键（被删掉的记为 `null`）。广播只带变化部分，第二个窗口
 * 就不必为一次输入框改动接收整份工作区。
 */
export function uiStateChangeSet(
  current: Record<string, unknown> | null | undefined,
  next: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const before = current && typeof current === 'object' ? current : {};
  const after = next && typeof next === 'object' ? next : {};
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    if (!uiStateValuesEqual(before[key], value)) changed[key] = value;
  }
  for (const key of Object.keys(before)) {
    if (!(key in after)) changed[key] = null;
  }
  return changed;
}

/** 磁盘上的键值表读进来时过滤掉认不出来的键：版本回退或手改文件都不该让页面崩。 */
export function sanitizeUiStateKeys(raw: unknown): Record<string, unknown> {
  const keys = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(keys)) {
    if (!isUiStateKey(key)) continue;
    if (value === null || value === undefined) continue;
    next[key] = value;
  }
  return next;
}

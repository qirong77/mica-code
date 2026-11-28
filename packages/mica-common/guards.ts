/**
 * 结构守卫：从磁盘、网络或插件传入的未知值，先过这里再断言类型。
 *
 * 只判断「是不是普通对象」（非 null、非数组），不校验字段；字段校验留在各自的解析函数里。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

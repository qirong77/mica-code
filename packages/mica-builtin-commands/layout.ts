export function maxColumnWidth(values: number[], fallback: number): number {
  return values.length > 0 ? Math.max(...values) : fallback;
}

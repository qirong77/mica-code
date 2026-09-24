import type { TaskMeta } from './types'

export interface TaskGroup {
  name: string
  tasks: TaskMeta[]
}

/**
 * Bucket the flat task list by `task.toml` category, preserving the server's
 * category order.  The 66 tasks collapse into 7 groups, which is the whole
 * point: a flat chip cloud is unreadable.
 *
 * A task with no metadata lands in an "其他" bucket at the end so nothing ever
 * silently disappears from the picker.
 */
export function groupTasks(
  catalog: TaskMeta[],
  allTasks: string[],
): TaskGroup[] {
  const byName = new Map(catalog.map((t) => [t.name, t]))
  const order: string[] = []
  const buckets = new Map<string, TaskMeta[]>()

  // Group order follows the catalogue (server-side CATEGORY_ORDER), not the
  // alphabetical task list -- otherwise the buckets shuffle into a random order.
  for (const meta of catalog) {
    const group = meta.group || '其他'
    if (!buckets.has(group)) {
      buckets.set(group, [])
      order.push(group)
    }
  }

  for (const name of allTasks) {
    const meta = byName.get(name)
    const group = meta?.group || '其他'
    if (!buckets.has(group)) {
      buckets.set(group, [])
      order.push(group)
    }
    buckets.get(group)!.push(
      meta ?? { name, category: '', group: '其他', subcategory: '', tags: [] },
    )
  }

  // Drop buckets the catalogue knows about but that are not in the run's task
  // selection, so an empty category header never shows up.
  return order
    .map((name) => ({ name, tasks: buckets.get(name)!.filter((t) => allTasks.includes(t.name)) }))
    .filter((g) => g.tasks.length > 0)
}

/** Which groups contain a selected task — used to auto-expand on first paint. */
export function groupsWithSelection(
  groups: TaskGroup[],
  selected: string[],
): string[] {
  const picked = new Set(selected)
  return groups
    .filter((g) => g.tasks.some((t) => picked.has(t.name)))
    .map((g) => g.name)
}

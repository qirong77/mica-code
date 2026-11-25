import type { EffortOption } from '@packages/mica-config/index.js';
import type { PluginSubagentContextMode } from '@packages/mica-plugin/index.js';
import { findPathConflict, normalizeOwnedPaths } from '@packages/mica-tools/index.js';

export type SubagentRunSpec = {
  description: string;
  prompt: string;
  subagent_type?: string;
  effort?: EffortOption;
  context_mode?: PluginSubagentContextMode;
  context_files?: string[];
  owned_paths?: string[];
  run_in_background?: boolean;
  id?: string;
  depends_on?: string[];
};

export type PlannedSubagentRun = SubagentRunSpec & {
  id: string;
  depends_on: string[];
  owned_paths: string[];
};

export function parseRunManySpecs(value: unknown): SubagentRunSpec[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('run_many requires a non-empty tasks array.');
  }
  return value.map((item, index) => parseRunSpec(item, index));
}

export function planSubagentRuns(
  specs: SubagentRunSpec[],
  options: { maxParallel?: number } = {},
): PlannedSubagentRun[] {
  const maxParallel = options.maxParallel ?? 4;
  if (!Number.isInteger(maxParallel) || maxParallel <= 0) {
    throw new Error('max_parallel must be a positive integer.');
  }

  const planned: PlannedSubagentRun[] = specs.map((spec, index) => ({
    ...spec,
    id: (spec.id?.trim() || `task-${index + 1}`).trim(),
    depends_on: [...new Set((spec.depends_on ?? []).map((item) => item.trim()).filter(Boolean))],
    owned_paths: normalizeOwnedPaths(spec.owned_paths ?? []),
  }));

  const ids = new Set(planned.map((item) => item.id));
  if (ids.size !== planned.length) throw new Error('run_many task ids must be unique.');
  for (const task of planned) {
    for (const dep of task.depends_on) {
      if (!ids.has(dep)) throw new Error(`Unknown depends_on task id: ${dep}`);
      if (dep === task.id) throw new Error(`Task ${task.id} cannot depend on itself.`);
    }
  }

  // Detect cycles with Kahn.
  const indegree = new Map(planned.map((task) => [task.id, task.depends_on.length]));
  const dependents = new Map<string, string[]>();
  for (const task of planned) {
    for (const dep of task.depends_on) {
      const list = dependents.get(dep) ?? [];
      list.push(task.id);
      dependents.set(dep, list);
    }
  }
  const queue = planned.filter((task) => (indegree.get(task.id) ?? 0) === 0).map((task) => task.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const value = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, value);
      if (value === 0) queue.push(next);
    }
  }
  if (order.length !== planned.length) throw new Error('run_many task graph contains a cycle.');

  const byId = new Map(planned.map((task) => [task.id, task]));
  // Rolling dispatch can overlap tasks at different depths. A wave-only check
  // misses e.g. A -> B while an unrelated C is still using B's paths. Require an
  // explicit dependency for conflicting paths unless the batch is serial.
  const ancestors = new Map<string, Set<string>>();
  for (const id of order) {
    const task = byId.get(id)!;
    const dependencies = new Set<string>();
    for (const dep of task.depends_on) {
      dependencies.add(dep);
      for (const ancestor of ancestors.get(dep) ?? []) dependencies.add(ancestor);
    }
    ancestors.set(id, dependencies);
  }
  if (maxParallel > 1) {
    for (let i = 0; i < planned.length; i++) {
      for (let j = i + 1; j < planned.length; j++) {
        const left = planned[i]!;
        const right = planned[j]!;
        if (ancestors.get(left.id)?.has(right.id) || ancestors.get(right.id)?.has(left.id)) continue;
        const conflict = findPathConflict(left.owned_paths, right.owned_paths);
        if (conflict) {
          throw new Error(
            `run_many owned_paths conflict between ${left.id} and ${right.id}: ${conflict.left} overlaps ${conflict.right}. Add depends_on or use max_parallel=1.`,
          );
        }
      }
    }
  }

  return order.map((id) => byId.get(id)!);
}

function parseRunSpec(value: unknown, index: number): SubagentRunSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`tasks[${index}] must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const description = asRequiredString(record.description, `tasks[${index}].description`);
  const prompt = asRequiredString(record.prompt, `tasks[${index}].prompt`);
  for (const field of ['depends_on', 'owned_paths', 'context_files'] as const) {
    if (record[field] !== undefined && !Array.isArray(record[field])) {
      throw new Error(`tasks[${index}].${field} must be an array of strings.`);
    }
  }
  return {
    description,
    prompt,
    ...(typeof record.subagent_type === 'string' ? { subagent_type: record.subagent_type } : {}),
    ...(typeof record.effort === 'string' ? { effort: record.effort as EffortOption } : {}),
    ...(typeof record.context_mode === 'string'
      ? { context_mode: record.context_mode as PluginSubagentContextMode }
      : {}),
    ...(Array.isArray(record.context_files)
      ? {
          context_files: record.context_files.map((item, itemIndex) =>
            asRequiredString(item, `tasks[${index}].context_files[${itemIndex}]`),
          ),
        }
      : {}),
    ...(Array.isArray(record.owned_paths)
      ? {
          owned_paths: record.owned_paths.map((item, itemIndex) =>
            asRequiredString(item, `tasks[${index}].owned_paths[${itemIndex}]`),
          ),
        }
      : {}),
    ...(typeof record.run_in_background === 'boolean' ? { run_in_background: record.run_in_background } : {}),
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(Array.isArray(record.depends_on)
      ? {
          depends_on: record.depends_on.map((item, itemIndex) =>
            asRequiredString(item, `tasks[${index}].depends_on[${itemIndex}]`),
          ),
        }
      : {}),
  };
}

function asRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  return value.trim();
}

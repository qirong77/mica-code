import type { EffortOption } from '@packages/mica-config/index.js';
import type { SubagentContextMode } from './subagentDefinitions.js';
import { findPathConflict, normalizeOwnedPaths } from './subagentPathLease.js';

export type SubagentRunSpec = {
  description: string;
  prompt: string;
  subagent_type?: string;
  effort?: EffortOption;
  context_mode?: SubagentContextMode;
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

  // Soft validation: warn-level conflicts become hard errors for same-wave owned paths.
  const byId = new Map(planned.map((task) => [task.id, task]));
  const waveById = new Map<string, number>();
  for (const id of order) {
    const task = byId.get(id)!;
    const wave = task.depends_on.reduce((max, dep) => Math.max(max, (waveById.get(dep) ?? 0) + 1), 0);
    waveById.set(id, wave);
  }
  const waves = new Map<number, PlannedSubagentRun[]>();
  for (const task of planned) {
    const wave = waveById.get(task.id) ?? 0;
    const list = waves.get(wave) ?? [];
    list.push(task);
    waves.set(wave, list);
  }
  for (const [, waveTasks] of waves) {
    if (waveTasks.length > maxParallel) {
      throw new Error(
        `run_many wave requires ${waveTasks.length} parallel tasks but max_parallel is ${maxParallel}. Add depends_on or raise max_parallel.`,
      );
    }
    for (let i = 0; i < waveTasks.length; i++) {
      for (let j = i + 1; j < waveTasks.length; j++) {
        const left = waveTasks[i]!;
        const right = waveTasks[j]!;
        const conflict = findPathConflict(left.owned_paths, right.owned_paths);
        if (conflict) {
          throw new Error(
            `run_many owned_paths conflict between ${left.id} and ${right.id}: ${conflict.left} overlaps ${conflict.right}`,
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
  return {
    description,
    prompt,
    ...(typeof record.subagent_type === 'string' ? { subagent_type: record.subagent_type } : {}),
    ...(typeof record.effort === 'string' ? { effort: record.effort as EffortOption } : {}),
    ...(typeof record.context_mode === 'string' ? { context_mode: record.context_mode as SubagentContextMode } : {}),
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

import { readFileSync } from 'node:fs';
import { writeTextFileAtomic } from '@packages/mica-config/atomicWrite.js';

/**
 * `$MICA_HOME/plugin-data/evolution/` 下的两份文件：
 *
 * - `state.json`：内部账本，记每个会话文件处理过的签名与迁移，决定下一轮要跳过谁；
 * - `data.json`：对外状态，配置页插件详情读它（清单 `status` 声明的键）。
 *
 * 状态文件坏掉不能让清洗停摆：读不出来就当成空账本重建，最多多跑一次幂等迁移。
 */
export type EvolutionFileState = {
  /** `size:mtimeMs`：文件变过就重新评估一次。 */
  signature: string;
  /** 已经在这份文件上跑过的迁移 id。 */
  migrations: string[];
  /** 解析不了的文件：签名不变就不要再试。 */
  broken?: boolean;
};

export type EvolutionState = {
  version: 1;
  lastRunAt: string | null;
  files: Record<string, EvolutionFileState>;
};

export function createEvolutionState(): EvolutionState {
  return { version: 1, lastRunAt: null, files: {} };
}

export function fileSignature(stat: { size: number; mtimeMs: number }): string {
  return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
}

export function readEvolutionState(path: string): EvolutionState {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return createEvolutionState();
    const data = parsed as Record<string, unknown>;
    if (data.version !== 1 || !data.files || typeof data.files !== 'object') {
      return createEvolutionState();
    }
    const files: Record<string, EvolutionFileState> = {};
    for (const [id, value] of Object.entries(data.files as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.signature !== 'string') continue;
      files[id] = {
        signature: entry.signature,
        migrations: Array.isArray(entry.migrations)
          ? entry.migrations.filter((item): item is string => typeof item === 'string')
          : [],
        ...(entry.broken === true ? { broken: true } : {}),
      };
    }
    return {
      version: 1,
      lastRunAt: typeof data.lastRunAt === 'string' ? data.lastRunAt : null,
      files,
    };
  } catch {
    return createEvolutionState();
  }
}

export function writeEvolutionState(path: string, state: EvolutionState): void {
  writeTextFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** 配置页「运行状态」那一段：值是字符串，没写过的键显示「尚未上报」。 */
export type EvolutionStatus = {
  lastRun: string;
  cleaned: string;
  pending: string;
  migrations: string;
};

export function writeEvolutionStatus(path: string, status: EvolutionStatus): void {
  writeTextFileAtomic(path, `${JSON.stringify(status, null, 2)}\n`);
}

/** 本地时间 `YYYY-MM-DD HH:mm`：状态行给人看，不写 ISO。 */
export function formatStatusTime(time: number): string {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

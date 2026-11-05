/**
 * 非会话数据的迁移：`$MICA_HOME` 下那些不属于会话快照的旧形态数据。
 *
 * 与会话迁移（`../migrations.ts`）的分工：
 * - 会话迁移是**纯函数**，由 `run.ts` 按文件签名决定要不要重跑，改的是会话 JSON；
 * - 这里改的是插件自己的数据文件（记忆、标签、config.json）。它们不在会话目录里，
 *   也没有签名账本，所以每次宿主启动都跑一遍——幂等 + 读一个小文件，代价可以忽略。
 *
 * 每条迁移必须满足同样的三条：幂等、不删除用户数据（只增补 / 改名 / 换位置）、
 * 只看文件内容。
 */
export type DataMigrationContext = {
  /** `$MICA_HOME`。 */
  home: string;
  log: (event: string, detail?: Record<string, unknown>) => void;
};

export type DataMigration = {
  /** 稳定标识，显示在 `/evolution status` 与日志里。 */
  id: string;
  /** 一句话说明这条迁移把旧数据改成什么。 */
  description: string;
  /** 就地改写，返回改动的对象数；0 表示已经是当前形态。 */
  run(context: DataMigrationContext): number;
};

export type DataMigrationOutcome = {
  id: string;
  changed: number;
  /** 迁移自身抛错时的信息。不让一条迁移的失败挡住其余迁移。 */
  error?: string;
};

export function runDataMigrations(
  context: DataMigrationContext,
  migrations: DataMigration[],
): DataMigrationOutcome[] {
  const outcomes: DataMigrationOutcome[] = [];
  for (const migration of migrations) {
    try {
      const changed = migration.run(context);
      outcomes.push({ id: migration.id, changed });
      if (changed > 0) context.log('evolution:data-migrated', { id: migration.id, changed });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push({ id: migration.id, changed: 0, error: message });
      context.log('evolution:data-migration-failed', { id: migration.id, error: message });
    }
  }
  return outcomes;
}

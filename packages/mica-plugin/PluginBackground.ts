import type { Disposable } from '@packages/mica-common/index.js';

/**
 * 插件注册的一段常驻工作（周期轮询、心跳、增量同步）。
 *
 * 存在的理由：需要「一直在跑」的插件以前只能自己去碰 launchd / systemd / 自建
 * `setInterval`，而宿主看不见它们——插件停用了、进程要退了，这些循环还在跑。
 * 交给宿主调度之后，插件的生命周期就是这段工作的生命周期：注册跟着 setup，
 * 停止跟着 dispose，没有任何活到插件之外的入口。
 *
 * 调度用 `setTimeout` 链而不是 `setInterval`：下一次的间隔由上一轮跑完之后再算，
 * 单轮变慢不会堆积重叠执行，插件也可以按状态动态决定下次等多久（退避）。
 */
export type PluginBackgroundTask = {
  /** 插件内唯一，重复注册报错。 */
  id: string;
  /**
   * 两轮之间的间隔（毫秒）。传函数时每轮结束后调用一次，可以按状态退避。
   *
   * 宿主不为它设上下限：退避策略是插件的事（例如「有人看才快、没人看就慢」）。
   * 但间隔小于 1000ms 会被抬到 1000ms，避免插件无意间把宿主拖成忙循环。
   */
  every: number | (() => number);
  /** 一轮工作。抛错只记在该插件健康状态与日志里，不影响后续调度。 */
  run(context: { signal: AbortSignal; tick: number }): void | Promise<void>;
  /** 第一轮之前的等待，默认等于 `every`。 */
  delay?: number;
  /** setup 之后立刻跑第一轮，默认 false。 */
  immediate?: boolean;
};

export type PluginBackgroundState = {
  id: string;
  /** 是否有一轮正在执行。 */
  running: boolean;
  /** 上一轮结束的时间戳；还没跑过为 null。 */
  lastRunAt: number | null;
  /** 下一轮的预定时间；已停止为 null。 */
  nextRunAt: number | null;
  /** 已完成的轮次数。 */
  ticks: number;
  /** 已捕获的失败次数。 */
  failures: number;
};

export type PluginBackgroundApi = {
  register(task: PluginBackgroundTask): Disposable;
  list(): PluginBackgroundState[];
  /** 停掉本插件注册的全部常驻任务。由 manager 在插件卸载时调用。 */
  disposeAll(): void;
};

const MIN_INTERVAL_MS = 1000;

/**
 * 一个插件名下的调度器。
 *
 * 每份 ctx 一个实例：插件之间互相看不见对方的任务，`disposeAll` 只会停掉自己注册的。
 */
export function createPluginBackgroundScheduler(options: {
  pluginId: string;
  onError: (taskId: string, error: unknown) => void;
  now?: () => number;
  /**
   * `false` 表示这个宿主不跑常驻任务（配置页动作那种一次性进程）：注册照收，但不排期。
   * 插件仍能拿到 `ctx.background`，因此不会因为「缺能力」而整块跳过或写出误导性的健康状态。
   */
  enabled?: boolean;
}): PluginBackgroundApi {
  const now = options.now ?? Date.now;
  const enabled = options.enabled ?? true;
  const tasks = new Map<string, RegisteredTask>();

  type RegisteredTask = {
    task: PluginBackgroundTask;
    state: PluginBackgroundState;
    timer: ReturnType<typeof setTimeout> | null;
    controller: AbortController | null;
    stopped: boolean;
  };

  const intervalOf = (task: PluginBackgroundTask): number => {
    const raw = typeof task.every === 'function' ? task.every() : task.every;
    const value = Number.isFinite(raw) ? Math.floor(raw) : MIN_INTERVAL_MS;
    return Math.max(MIN_INTERVAL_MS, value);
  };

  const schedule = (entry: RegisteredTask, delay: number) => {
    if (entry.stopped) return;
    entry.state.nextRunAt = now() + delay;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void runOnce(entry);
    }, delay);
    // 常驻任务不该单独把进程钉住：宿主该退的时候得能退。
    entry.timer.unref?.();
  };

  const runOnce = async (entry: RegisteredTask) => {
    if (entry.stopped) return;
    const controller = new AbortController();
    entry.controller = controller;
    entry.state.running = true;
    try {
      await entry.task.run({ signal: controller.signal, tick: entry.state.ticks + 1 });
      entry.state.ticks += 1;
    } catch (error) {
      entry.state.failures += 1;
      options.onError(entry.task.id, error);
    } finally {
      entry.state.running = false;
      entry.state.lastRunAt = now();
      entry.controller = null;
    }
    if (entry.stopped) return;
    schedule(entry, intervalOf(entry.task));
  };

  return {
    register(task) {
      if (!task.id) throw new Error(`background task needs an id: ${options.pluginId}`);
      if (tasks.has(task.id)) {
        throw new Error(`background task already registered: ${options.pluginId}/${task.id}`);
      }
      const entry: RegisteredTask = {
        task,
        state: {
          id: task.id,
          running: false,
          lastRunAt: null,
          nextRunAt: null,
          ticks: 0,
          failures: 0,
        },
        timer: null,
        controller: null,
        stopped: false,
      };
      tasks.set(task.id, entry);
      if (enabled) schedule(entry, task.immediate ? 0 : (task.delay ?? intervalOf(task)));

      return {
        dispose: () => {
          entry.stopped = true;
          if (entry.timer) clearTimeout(entry.timer);
          entry.timer = null;
          entry.state.nextRunAt = null;
          entry.controller?.abort();
          entry.controller = null;
          tasks.delete(task.id);
        },
      };
    },
    list() {
      return [...tasks.values()].map((entry) => ({ ...entry.state }));
    },
    disposeAll() {
      for (const entry of [...tasks.values()]) {
        entry.stopped = true;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        entry.controller?.abort();
        entry.controller = null;
      }
      tasks.clear();
    },
  };
}

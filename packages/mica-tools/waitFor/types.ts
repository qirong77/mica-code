/**
 * `wait_for` 的等待条件模型。
 *
 * 一个条件由 `kind` + 一组 kind 专属字段组成，扁平地出现在工具入参里（
 * `MicaTool.validateInput` 只校验顶层声明的类型，互斥/枚举关系由工具自己
 * 归一化并返回可读错误）。归一化后的联合类型是判定逻辑与登记表唯一认的形状。
 */

export type WaitKind = 'task' | 'process' | 'file' | 'command' | 'http' | 'port' | 'duration';

export type FileUntil = 'exists' | 'missing' | 'changed' | 'matches';

export type CommandUntil = 'exit_zero' | 'exit_nonzero' | 'expected_exit_code' | 'stdout_matches' | 'stdout_changed';

export type HttpUntil = 'reachable' | 'status' | 'body_matches' | 'body_changed';

export type NormalizedWaitCondition =
  | { kind: 'task'; taskId: string; until: 'finished' }
  | { kind: 'process'; pid: number; until: 'exited' }
  | { kind: 'file'; filePath: string; until: FileUntil; pattern?: string }
  | {
      kind: 'command';
      command: string;
      cwd?: string;
      until: CommandUntil;
      expectedExitCode?: number;
      pattern?: string;
    }
  | {
      kind: 'http';
      url: string;
      method: string;
      until: HttpUntil;
      expectStatus?: number;
      headers?: Record<string, string>;
      body?: string;
      pattern?: string;
    }
  | { kind: 'port'; host: string; port: number; until: 'open' }
  | { kind: 'duration'; seconds: number };

/**
 * 跨轮次保留的观察基线（`changed` 系列条件要拿第一次观察到的值做对比）。
 * 由条件判定函数按需写入，登记表只是持有者——所以「用同一 wait_id 续等」
 * 不会把基线重置。
 */
export type WaitBaseline = Record<string, unknown>;

export type WaitProbeResult = {
  satisfied: boolean;
  /** 本次观察的一句话证据，展示在结果与 dock 行上。 */
  detail?: string;
  /**
   * 本次轮询本身失败（页面连不上、命令起不来、任务 id 不存在……）。
   * 只记录到 lastError 继续轮询，绝不因此判定条件成立或不成立——
   * 「等 service 起来」正是连不上才是常态的场景。
   */
  error?: string;
};

export const WAIT_KINDS: WaitKind[] = ['task', 'process', 'file', 'command', 'http', 'port', 'duration'];

import type { SshData, SshHost } from './Hosts.js';

/**
 * 「这次会话里模型能用哪几台」。
 *
 * 以前是一个全局开关（`data.json.enabled`）：打开之后**所有**配置好的机器都对模型可见，
 * 每开一个对话都得重新判断「这台机器现在该不该给它看」。现在这个决定跟着会话走：
 *
 * - 面板里「添加到会话」那一列是本次会话的集合，存在会话快照的 `pluginState.ssh`；
 * - 「自动添加到会话」是每台机器的**初值**：会话里还没人动过那一列时，集合就等于所有
 *   勾了自动的机器；
 * - 一旦有人在会话里勾/取消过，就以那份显式清单为准——自动那一列只影响新会话，
 *   不会每轮把人刚取消掉的机器又塞回来。
 *
 * 内核不解析这份状态（它只是一份 JSON），所以在这里把它过一遍形状。
 */

export const SSH_STATE_KEY = 'added';

export type SshScopeState = { added?: string[] };

export type SshScope = {
  /** 本次会话显式加过的机器；从没改过是 null（此时跟随 `autoAdd`）。 */
  explicit(): string[] | null;
  /** 覆盖成本次会话的机器清单（传空数组就是一台都不用）。 */
  set(ids: string[]): void;
};

/** 只认字符串数组：手改过会话文件的人写别的形状，当成「没改过」。 */
export function normalizeScopeState(input: unknown): string[] | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = (input as Record<string, unknown>)[SSH_STATE_KEY];
  if (!Array.isArray(raw)) return null;
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
}

/**
 * 生效的机器清单：显式清单优先，否则取「自动添加到会话」的那些。
 *
 * 显式清单可能指向已经删掉的机器——按清单里还在的那些过滤，不让一台删掉的机器继续
 * 出现在 prompt 或状态栏里。
 */
export function scopedHosts(data: SshData, explicit: string[] | null): SshHost[] {
  const wanted = explicit ?? data.hosts.filter((host) => host.autoAdd === true).map((host) => host.id);
  const allowed = new Set(wanted);
  return data.hosts.filter((host) => allowed.has(host.id));
}

/** 从宿主注入的 `ctx.sessionState` 做出这个 scope；没有那个能力时退化成「只看自动」。 */
export function createScope(api: { get<T = unknown>(): T | undefined; set(value: unknown): void } | undefined): SshScope {
  return {
    explicit: () => (api ? normalizeScopeState(api.get()) : null),
    set: (ids) => {
      if (!api) return;
      const next: SshScopeState = { [SSH_STATE_KEY]: [...new Set(ids)] };
      api.set(next);
    },
  };
}

/** 不落盘的宿主（`mica exec`）用这个：所有动作都当「没改过」。 */
export function createNoopScope(): SshScope {
  return { explicit: () => null, set: () => {} };
}

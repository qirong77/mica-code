import type { PromptControls } from '@packages/mica-common/promptControls.js';
import type { ConfigWebCapabilitiesRuntime } from '../src/shared/types.js';

export type CapabilityDraft = {
  scope: 'runtime' | 'defaults';
  key: string;
  selection: { disabledSkills: string[]; disabledTools: string[]; disabledMcpServers: string[] };
  /** 在编辑时绑定目标，防抖期间换会话也不会把草稿写到新目标。 */
  target?: ConfigWebCapabilitiesRuntime;
};

/** 仅在当前页面内存中保留未落盘草稿，设置导航或关闭再打开后仍可重试。 */
export function createCapabilityDraftCache<T>() {
  const entries = new Map<string, { value: T; error?: string }>();
  return {
    read: (key: string) => entries.get(key),
    remember(key: string, value: T) {
      entries.set(key, { value });
    },
    fail(key: string, value: T, error: string) {
      if (entries.get(key)?.value === value) entries.set(key, { value, error });
    },
    confirm(key: string, value: T) {
      if (entries.get(key)?.value === value) entries.delete(key);
    },
  };
}

export const capabilityDraftCache = createCapabilityDraftCache<CapabilityDraft>();
export const promptDraftCache = createCapabilityDraftCache<PromptControls>();

const writes = new Map<string, Promise<unknown>>();
let writeRevision = 0;

/** 加载期间有旧页面的保存完成时，重新读取，避免采用保存前的旧值。 */
export async function readStableCapabilityState<T>(read: () => Promise<T>): Promise<T> {
  for (;;) {
    const revision = writeRevision;
    const result = await read();
    if (revision === writeRevision) return result;
  }
}

/** 跨组件卸载仍按同一目标串行写，防止旧页面的迟到响应覆盖新草稿。 */
export function serializeCapabilityWrite<T>(key: string, write: () => Promise<T>): Promise<T> {
  const previous = writes.get(key) ?? Promise.resolve();
  const task = previous.then(write, write);
  writes.set(key, task);
  const cleanup = () => {
    writeRevision += 1;
    if (writes.get(key) === task) writes.delete(key);
  };
  void task.then(cleanup, cleanup);
  return task;
}

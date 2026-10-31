import { normalizePeerStore, type PeerStore } from './peers.js';

type PeerDataApi = {
  readData(): Promise<{ value?: unknown; version?: string | null; ok?: boolean; error?: string } | null>;
  writeData(value: PeerStore, options?: { expectedVersion: string | null }): Promise<unknown>;
};

/** 卡片内串行，跨窗口用版本比较重放修改，保留其它窗口已保存的记录。 */
export function createPeerPersistence(api: PeerDataApi) {
  let pending: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = pending.then(operation);
    pending = next.catch(() => {});
    return next;
  };
  const read = async () => {
    const result = await api.readData();
    if (result?.ok === false) throw new Error(result.error || '读取连接清单失败');
    return result;
  };

  return {
    load: () => serialize(async () => normalizePeerStore((await read())?.value)),
    update: (updater: (store: PeerStore) => PeerStore) =>
      serialize(async () => {
        for (let attempt = 0; attempt < 8; attempt++) {
          const snapshot = await read();
          const previous = normalizePeerStore(snapshot?.value);
          const next = updater(previous);
          if (next === previous) return next;
          const version = snapshot?.version;
          const options = typeof version === 'string' || version === null ? { expectedVersion: version } : undefined;
          const result = (await api.writeData(next, options)) as
            | { ok?: boolean; conflict?: boolean; error?: string }
            | undefined;
          if (result?.ok !== false) return next;
          if (!result.conflict) throw new Error(result.error || '保存连接清单失败');
        }
        throw new Error('连接清单正在其他窗口更新，请稍后重试');
      }),
  };
}

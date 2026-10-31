import { describe, expect, it, vi } from 'vitest';
import { emptyPeerStore, rememberPeer, setPeerNote, type PeerStore } from './peers.js';
import { createPeerPersistence } from './persistence.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('connection persistence', () => {
  it('waits for the initial read and keeps existing connections when the user connects immediately', async () => {
    let disk = rememberPeer(emptyPeerStore(), '10.0.0.1');
    const read = deferred<{ value: PeerStore }>();
    const api = {
      readData: vi
        .fn()
        .mockImplementationOnce(() => read.promise)
        .mockImplementation(async () => ({ value: disk })),
      writeData: vi.fn(async (next: PeerStore) => {
        disk = next;
      }),
    };
    const persistence = createPeerPersistence(api);
    const loading = persistence.load();
    const connecting = persistence.update((store) => rememberPeer(store, '10.0.0.2'));
    expect(api.writeData).not.toHaveBeenCalled();
    read.resolve({ value: disk });
    await loading;
    await connecting;
    expect(disk.peers.map((peer) => peer.url)).toEqual(['http://10.0.0.2:8787', 'http://10.0.0.1:8787']);
  });

  it('serializes note writes and preserves records saved by another window between edits', async () => {
    let disk = rememberPeer(emptyPeerStore(), '10.0.0.1');
    const firstWrite = deferred<void>();
    const started = deferred<void>();
    const api = {
      readData: vi.fn(async () => ({ value: disk })),
      writeData: vi.fn(async (next: PeerStore) => {
        if (api.writeData.mock.calls.length === 1) {
          started.resolve();
          await firstWrite.promise;
        }
        disk = next;
      }),
    };
    const persistence = createPeerPersistence(api);
    const first = persistence.update((store) => setPeerNote(store, 'http://10.0.0.1:8787', 'first'));
    const second = persistence.update((store) => setPeerNote(store, 'http://10.0.0.1:8787', 'latest'));
    await started.promise;
    expect(api.writeData).toHaveBeenCalledTimes(1);
    firstWrite.resolve();
    await first;
    await second;
    expect(disk.peers[0]?.note).toBe('latest');

    disk = rememberPeer(disk, '10.0.0.2');
    await persistence.update((store) => setPeerNote(store, 'http://10.0.0.1:8787', 'another edit'));
    expect(disk.peers).toHaveLength(2);
  });

  it('does not overwrite saved connections after a failed read and recovers on a later edit', async () => {
    const api = {
      readData: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ value: emptyPeerStore() }),
      writeData: vi.fn(async (_next: PeerStore) => {}),
    };
    const persistence = createPeerPersistence(api);
    await expect(persistence.update((store) => rememberPeer(store, '10.0.0.1'))).rejects.toThrow('offline');
    expect(api.writeData).not.toHaveBeenCalled();
    await persistence.update((store) => rememberPeer(store, '10.0.0.2'));
    expect(api.writeData).toHaveBeenCalledTimes(1);
  });

  it('replays conflicting edits from two windows instead of losing either connection', async () => {
    let disk = emptyPeerStore();
    let version = 0;
    const api = {
      readData: vi.fn(async () => ({ value: disk, version: String(version) })),
      writeData: vi.fn(async (next: PeerStore, options?: { expectedVersion: string | null }) => {
        if (options?.expectedVersion !== String(version)) return { ok: false, conflict: true };
        disk = next;
        version++;
        return { ok: true };
      }),
    };
    const first = createPeerPersistence(api);
    const second = createPeerPersistence(api);
    await Promise.all([
      first.update((store) => rememberPeer(store, '10.0.0.1')),
      second.update((store) => rememberPeer(store, '10.0.0.2')),
    ]);
    expect(disk.peers.map((peer) => peer.url).sort()).toEqual(['http://10.0.0.1:8787', 'http://10.0.0.2:8787']);
    expect(api.writeData).toHaveBeenCalledTimes(3);
  });

  it('reports structured read and write errors without treating them as saved data', async () => {
    const api = {
      readData: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, error: 'permission denied' })
        .mockResolvedValue({ value: emptyPeerStore() }),
      writeData: vi.fn(async () => ({ ok: false, error: 'disk full' })),
    };
    const persistence = createPeerPersistence(api);
    await expect(persistence.update((store) => rememberPeer(store, '10.0.0.1'))).rejects.toThrow('permission denied');
    expect(api.writeData).not.toHaveBeenCalled();
    await expect(persistence.update((store) => rememberPeer(store, '10.0.0.1'))).rejects.toThrow('disk full');
  });

  it('bounds conflict retries and leaves the edit failed when another window stays busy', async () => {
    const api = {
      readData: vi.fn(async () => ({ value: emptyPeerStore(), version: 'current' })),
      writeData: vi.fn(async () => ({ ok: false, conflict: true })),
    };
    await expect(createPeerPersistence(api).update((store) => rememberPeer(store, '10.0.0.1'))).rejects.toThrow(
      '其他窗口',
    );
    expect(api.writeData).toHaveBeenCalledTimes(8);
  });

  it('surfaces a failed write and allows the next attempt to complete', async () => {
    const api = {
      readData: vi.fn(async () => ({ value: emptyPeerStore() })),
      writeData: vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue({ ok: true }),
    };
    const persistence = createPeerPersistence(api);
    await expect(persistence.update((store) => rememberPeer(store, '10.0.0.1'))).rejects.toThrow('disk full');
    await expect(persistence.update((store) => rememberPeer(store, '10.0.0.2'))).resolves.toMatchObject({
      peers: [{ url: 'http://10.0.0.2:8787' }],
    });
  });
});

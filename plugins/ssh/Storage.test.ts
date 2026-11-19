import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { emptyData, mutateData, readData, upsertHost } from './Hosts.js';
import { emptyData as emptySchedule } from '../schedule/schedule.js';
import { mutateSchedule, readScheduleData } from '../schedule/store.js';

const fault = vi.hoisted(() => ({ file: '', code: '', rename: false }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    readFileSync: vi.fn((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === fault.file && fault.code)
        throw Object.assign(new Error('injected read failure'), { code: fault.code });
      return actual.readFileSync(...args);
    }),
    renameSync: vi.fn((from: fs.PathLike, to: fs.PathLike) => {
      if (to === fault.file && fault.rename) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
      actual.renameSync(from, to);
    }),
  };
});

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), 'mica-ssh-storage-'));
  fault.file = '';
  fault.code = '';
  fault.rename = false;
  vi.clearAllMocks();
});
afterEach(() => {
  fault.code = '';
  fault.rename = false;
  fs.rmSync(dir, { recursive: true, force: true });
});

const host = upsertHost(emptyData(), {
  id: 'test',
  host: 'example.invalid',
  user: 'root',
  auth: 'key',
  keyPath: '/mock/key',
}).host;
const task = { id: 't1', name: 'canary', start: '2026-11-01', end: '2026-11-02', color: 'blue', note: '' };
const stores = [
  {
    name: 'ssh',
    valid: () => ({ ...emptyData(), hosts: [host] }),
    invalid: [
      null,
      [],
      {},
      { version: 1, hosts: {} },
      { version: 1, hosts: [null] },
      { version: 1, hosts: [{ ...host, readOnly: 'no' }] },
      { version: 1, hosts: [host, host] },
    ],
    read: readData,
    mutate: (file: string, callback: ReturnType<typeof vi.fn>) =>
      mutateData(file, (data) => {
        callback();
        return { data, result: 'saved' };
      }),
  },
  {
    name: 'schedule',
    valid: () => ({ ...emptySchedule(), tasks: [task] }),
    invalid: [
      null,
      [],
      {},
      { version: 1, tasks: {} },
      { version: 1, tasks: [null] },
      { version: 1, tasks: [{ ...task, start: 'bad' }] },
      { version: 1, tasks: [task, task] },
      { version: 1, tasks: [{ ...task, note: 123 }] },
    ],
    read: readScheduleData,
    mutate: (file: string, callback: ReturnType<typeof vi.fn>) =>
      mutateSchedule(file, (data) => {
        callback();
        return { data, message: 'saved' };
      }),
  },
];

for (const store of stores) {
  describe(`${store.name} fail-closed storage`, () => {
    it.each(['{ broken canary JSON', ...store.invalid.map((entry) => JSON.stringify(entry))])(
      'preserves invalid source bytes: %s',
      async (source) => {
        const file = join(dir, 'data.json');
        fs.writeFileSync(file, source, 'utf8');
        const mutation = vi.fn();
        await expect(store.mutate(file, mutation)).rejects.toMatchObject({ code: 'invalid_data' });
        expect(mutation).not.toHaveBeenCalled();
        expect(fs.renameSync).not.toHaveBeenCalled();
        expect(fs.readFileSync(file, 'utf8')).toBe(source);
        expect(fs.readdirSync(`${file}.lock.owners`)).toEqual([]);
        expect(fs.readdirSync(dir).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
      },
    );

    it.each(['EACCES', 'EIO'])('propagates %s without mutation or rename', async (code) => {
      const file = join(dir, 'data.json');
      const source = JSON.stringify(store.valid());
      fs.writeFileSync(file, source, 'utf8');
      fault.file = file;
      fault.code = code;
      const mutation = vi.fn();
      expect(() => store.read(file)).toThrow('injected read failure');
      await expect(store.mutate(file, mutation)).rejects.toMatchObject({ code });
      expect(mutation).not.toHaveBeenCalled();
      expect(fs.renameSync).not.toHaveBeenCalled();
      fault.code = '';
      expect(fs.readFileSync(file, 'utf8')).toBe(source);
      expect(fs.readdirSync(`${file}.lock.owners`)).toEqual([]);
    });

    it('initializes only a missing file, then reads the latest valid baseline', async () => {
      const file = join(dir, 'data.json');
      const mutation = vi.fn();
      expect(store.read(file)).toMatchObject({ version: 1 });
      await expect(store.mutate(file, mutation)).resolves.toBe('saved');
      fs.writeFileSync(file, JSON.stringify(store.valid()), 'utf8');
      await expect(store.mutate(file, mutation)).resolves.toBe('saved');
      expect(mutation).toHaveBeenCalledTimes(2);
      expect(fs.renameSync).toHaveBeenCalledTimes(2);
      expect(store.read(file)).toMatchObject(store.name === 'ssh' ? { hosts: [host] } : { tasks: [task] });
    });

    it('preserves the old file and removes the temporary file when atomic rename fails', async () => {
      const file = join(dir, 'data.json');
      const source = JSON.stringify(store.valid());
      fs.writeFileSync(file, source, 'utf8');
      fault.file = file;
      fault.rename = true;
      await expect(store.mutate(file, vi.fn())).rejects.toMatchObject({ code: 'EIO' });
      expect(fs.readFileSync(file, 'utf8')).toBe(source);
      expect(fs.readdirSync(dir).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
      expect(fs.readdirSync(`${file}.lock.owners`)).toEqual([]);
    });
  });
}

it('SSH waits for another writer and applies its change to the latest data', async () => {
  const file = join(dir, 'data.json');
  fs.writeFileSync(file, JSON.stringify(emptyData()), 'utf8');
  const release = acquireProcessLock(`${file}.lock`)!;
  const pending = mutateData(file, (data) => ({
    data: { ...data, hosts: [...data.hosts, { ...host, id: 'second' }] },
    result: 'saved',
  }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.writeFileSync(file, JSON.stringify({ ...emptyData(), hosts: [host] }), 'utf8');
  release();
  await expect(pending).resolves.toBe('saved');
  expect(readData(file).hosts.map((entry) => entry.id)).toEqual(['test', 'second']);
});

it('keeps the existing recognized legacy schedule import without dropping stages', () => {
  const file = join(dir, 'data.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      plans: [{ name: 'plan', stages: [{ id: 'stage', name: 'stage', start: '2026-11-01' }] }],
    }),
    'utf8',
  );
  expect(readScheduleData(file).tasks).toMatchObject([{ id: 'stage', name: 'plan · stage' }]);
});

import { describe, expect, it } from 'vitest';
import {
  PluginApiError,
  type PluginApiHandler,
  type PluginApiMethod,
  type PluginDataApi,
} from '@packages/mica-plugin/index.js';
import createApi from './api.js';
import { todayOf } from './dates.js';
import { nextColor } from './palette.js';
import { emptyData, type ScheduleData, type ScheduleTask } from './schedule.js';

type Stored = { value: unknown; version: string | null };

function clone<T>(value: T): T {
  return value === null || value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * `context.data` 的内存版本：行为与 `PluginData` 一致——带 `expectedVersion` 的 CAS、
 * 冲突时返回 `{ ok: false, conflict: true }`，版本只在成功写入后前进。
 */
function memoryStore(initial: ScheduleData | null = null) {
  let stored: Stored = { value: clone(initial), version: initial ? 'v0' : null };
  let counter = 0;
  let beforeNextWrite: (() => void) | null = null;
  let writes = 0;

  const data = {
    read: () => clone(stored),
    write: (value: unknown, options: { expectedVersion?: string | null } = {}) => {
      const hook = beforeNextWrite;
      beforeNextWrite = null;
      // 别人在这两次调用之间写进了磁盘：版本检查会失败，和真实宿主一样。
      hook?.();
      if (options.expectedVersion !== stored.version) return { ok: false, conflict: true, error: 'conflict' };
      counter += 1;
      writes += 1;
      stored = { value: clone(value), version: `v${counter}` };
      return { ok: true, version: `v${counter}` };
    },
    documents: {
      read: () => ({ value: null, version: null }),
      version: () => ({ version: null }),
      write: () => ({ ok: true, version: 'unused' }),
    },
  };

  return {
    data: data as unknown as PluginDataApi,
    /** 让下一次接口写入先撞上一次「页面刚写过」。 */
    onNextWrite(hook: () => void) {
      beforeNextWrite = hook;
    },
    /** 页面或另一个窗口直接写一次，不经过接口的 CAS。 */
    externalWrite(next: ScheduleData) {
      counter += 1;
      stored = { value: clone(next), version: `v${counter}` };
    },
    stored: () => clone(stored),
    tasks: () => (clone(stored.value) as ScheduleData).tasks,
    writes: () => writes,
  };
}

function createHandler(store: ReturnType<typeof memoryStore>): PluginApiHandler {
  return createApi({
    pluginId: 'schedule',
    pluginVersion: '3.1.0',
    data: store.data,
    settings: { get: () => ({}) },
  });
}

async function request(
  handler: PluginApiHandler,
  method: PluginApiMethod,
  path: string,
  options: { body?: unknown; signal?: AbortSignal } = {},
): Promise<Record<string, any>> {
  const response = await handler.handle({
    method,
    path: path.split('/').filter(Boolean),
    query: {},
    body: options.body,
    signal: options.signal ?? new AbortController().signal,
  });
  return response.body as Record<string, any>;
}

async function expectFailure(promise: Promise<unknown>, status: number, code: string): Promise<PluginApiError> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  if (!(error instanceof PluginApiError)) throw new Error(`期望 PluginApiError，实际是：${String(error)}`);
  expect({ status: error.status, code: error.code }).toEqual({ status, code });
  return error;
}

function task(overrides: Partial<ScheduleTask> = {}): ScheduleTask {
  return {
    id: 't_seed',
    name: '已有任务',
    start: '2026-11-02',
    end: '2026-11-06',
    color: 'blue',
    note: '',
    ...overrides,
  };
}

function seeded(tasks: ScheduleTask[]): ScheduleData {
  return { ...emptyData(), tasks };
}

describe('Schedule plugin api', () => {
  it('reads an empty schedule with today and the readable rendering', async () => {
    const handler = createHandler(memoryStore());
    const body = await request(handler, 'GET', '/overview');

    expect(body).toMatchObject({ today: todayOf(), title: '我的排期', scale: 'day', zoom: 1, tasks: [] });
    expect(body.text).toContain('还没有任何任务');
  });

  it('lists stored tasks with their ids inside the readable text', async () => {
    const handler = createHandler(memoryStore(seeded([task()])));
    const body = await request(handler, 'GET', '/overview');

    expect(body.tasks).toEqual([task()]);
    expect(body.text).toContain(`[t_seed] 已有任务`);
  });

  it('creates a one-day task by default and stamps the stored document', async () => {
    const store = memoryStore();
    const handler = createHandler(store);
    const created = await request(handler, 'POST', '/tasks', { body: { name: '钱包改版', start: '2026-11-02' } });

    expect(created).toMatchObject({
      name: '钱包改版',
      start: '2026-11-02',
      end: '2026-11-02',
      color: 'blue',
      note: '',
    });
    expect(created.id).toMatch(/^t_/);
    expect(store.tasks()).toEqual([created]);
    const stored = store.stored().value as ScheduleData;
    expect(stored.summary).toBe('1 个任务');
    expect(stored.updatedAtMs).toBeGreaterThan(0);
    expect(stored.updatedAt).not.toBe('');
  });

  it('creates a full range with an explicit color and note, rotating the default color', async () => {
    const store = memoryStore();
    const handler = createHandler(store);
    const first = await request(handler, 'POST', '/tasks', {
      body: { name: '联调', start: '2026-11-02', end: '2026-11-06', color: 'rose', note: '## 前置\n- 后端接口就绪' },
    });
    const second = await request(handler, 'POST', '/tasks', { body: { name: '上线', start: '2026-11-09' } });

    expect(first).toMatchObject({ start: '2026-11-02', end: '2026-11-06', color: 'rose' });
    expect(first.note).toContain('后端接口就绪');
    // 没指定颜色时顺着色板换，和页面里「新建任务」的默认行为一致
    expect(second.color).toBe(nextColor(1));
    expect(store.tasks().map((item) => item.name)).toEqual(['联调', '上线']);
  });

  it('patches only the fields it was given', async () => {
    const store = memoryStore(seeded([task()]));
    const handler = createHandler(store);
    const updated = await request(handler, 'PATCH', '/tasks/t_seed', { body: { name: '联调' } });

    expect(updated).toMatchObject({
      id: 't_seed',
      name: '联调',
      start: '2026-11-02',
      end: '2026-11-06',
      color: 'blue',
    });
    expect(store.tasks()[0]).toEqual(updated);
  });

  it('reschedules and clears a note', async () => {
    const store = memoryStore(seeded([task({ note: '旧备注' })]));
    const handler = createHandler(store);
    const moved = await request(handler, 'PATCH', '/tasks/t_seed', {
      body: { start: '2026-11-09', end: '2026-11-13' },
    });
    expect(moved).toMatchObject({ start: '2026-11-09', end: '2026-11-13', note: '旧备注' });

    const cleared = await request(handler, 'PATCH', '/tasks/t_seed', { body: { note: '' } });
    expect(cleared.note).toBe('');
    expect(store.tasks()[0]).toMatchObject({ start: '2026-11-09', note: '' });
  });

  it('deletes one task and reports its id', async () => {
    const store = memoryStore(seeded([task(), task({ id: 't_keep', name: '保留' })]));
    const handler = createHandler(store);

    await expect(request(handler, 'DELETE', '/tasks/t_seed')).resolves.toEqual({ deleted: 't_seed' });
    expect(store.tasks()).toEqual([task({ id: 't_keep', name: '保留' })]);
  });

  it('answers 404 for an id that is not on disk and writes nothing', async () => {
    const store = memoryStore(seeded([task()]));
    const handler = createHandler(store);

    const patchError = await expectFailure(
      request(handler, 'PATCH', '/tasks/t_gone', { body: { name: '改名' } }),
      404,
      'task_not_found',
    );
    expect(patchError.message).toContain('/plugin/schedule/api/overview');
    await expectFailure(request(handler, 'DELETE', '/tasks/t_gone'), 404, 'task_not_found');
    expect(store.writes()).toBe(0);
  });

  it('rejects invalid input as 400 without touching the file', async () => {
    const store = memoryStore(seeded([task()]));
    const handler = createHandler(store);
    const post = (body: unknown) => request(handler, 'POST', '/tasks', { body });

    await expectFailure(post({ start: '2026-11-02' }), 400, 'invalid_request');
    await expectFailure(post({ name: '  ', start: '2026-11-02' }), 400, 'invalid_request');
    await expectFailure(post({ name: '联调', start: '2026-02-30' }), 400, 'invalid_request');
    await expectFailure(post({ name: '联调', start: '2026-11-06', end: '2026-11-02' }), 400, 'invalid_request');
    await expectFailure(post({ name: '联调', start: '2026-11-02', color: 'pink' }), 400, 'invalid_request');
    await expectFailure(post({ name: '联调', start: '2026-11-02', colour: 'rose' }), 400, 'invalid_request');
    await expectFailure(post('联调'), 400, 'invalid_request');
    await expectFailure(request(handler, 'PATCH', '/tasks/t_seed', { body: {} }), 400, 'invalid_request');
    expect(store.writes()).toBe(0);
  });

  it('replays the operation on a version conflict instead of overwriting the other write', async () => {
    const store = memoryStore(seeded([task()]));
    const handler = createHandler(store);
    // 接口读完、还没写进去时，另一个窗口加了一条任务
    store.onNextWrite(() => {
      const current = store.stored().value as ScheduleData;
      store.externalWrite(seeded([...current.tasks, task({ id: 't_other', name: '另一个窗口' })]));
    });

    const created = await request(handler, 'POST', '/tasks', { body: { name: '联调', start: '2026-11-02' } });

    expect(store.tasks().map((item) => item.name)).toEqual(['已有任务', '另一个窗口', '联调']);
    expect(store.tasks().find((item) => item.id === created.id)).toEqual(created);
    expect(store.stored().version).not.toBe('v0');
  });

  it('gives up with 409 after five conflicting attempts', async () => {
    const store = memoryStore(seeded([task()]));
    let attempts = 0;
    const handler = createApi({
      pluginId: 'schedule',
      pluginVersion: '3.1.0',
      data: {
        ...store.data,
        write: () => {
          attempts += 1;
          return { ok: false, conflict: true, error: 'conflict' };
        },
      },
      settings: { get: () => ({}) },
    });

    await expectFailure(
      request(handler, 'POST', '/tasks', { body: { name: '联调', start: '2026-11-02' } }),
      409,
      'version_conflict',
    );
    expect(attempts).toBe(5);
  });

  it('refuses to treat a corrupt file as empty', async () => {
    const store = memoryStore();
    const write = store.data.write;
    let writes = 0;
    const handler = createApi({
      pluginId: 'schedule',
      pluginVersion: '3.1.0',
      data: {
        ...store.data,
        write: (value, options) => {
          writes += 1;
          return write(value, options);
        },
      },
      settings: { get: () => ({}) },
    });
    // 版本有值（文件存在）但内容不是合法排期
    store.externalWrite({ version: 1, tasks: 'nope' } as unknown as ScheduleData);

    await expectFailure(request(handler, 'GET', '/overview'), 409, 'invalid_data');
    await expectFailure(
      request(handler, 'POST', '/tasks', { body: { name: '联调', start: '2026-11-02' } }),
      409,
      'invalid_data',
    );
    expect(writes).toBe(0);
  });

  it('answers unknown endpoints with 404 and names the real ones', async () => {
    const store = memoryStore(seeded([task()]));
    const handler = createHandler(store);
    const error = await expectFailure(request(handler, 'GET', '/tasks'), 404, 'not_found');

    expect(error.message).toContain('POST /tasks');
    await expectFailure(request(handler, 'PUT', '/tasks/t_seed', { body: { name: '改名' } }), 404, 'not_found');
    expect(store.writes()).toBe(0);
  });

  it('stops before reading when the caller disconnected', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const store = memoryStore(seeded([task()]));
    const handler = createHandler(store);

    await expect(request(handler, 'GET', '/overview', { signal: controller.signal })).rejects.toThrow('cancelled');
  });

  it('documents every endpoint with params, returns and a runnable example', () => {
    const handler = createHandler(memoryStore());

    expect(handler.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`)).toEqual([
      'GET /overview',
      'POST /tasks',
      'PATCH /tasks/:id',
      'DELETE /tasks/:id',
    ]);
    for (const endpoint of handler.endpoints) {
      expect(endpoint.summary.length).toBeGreaterThan(0);
      expect(endpoint.returns.length).toBeGreaterThan(0);
      expect(endpoint.example).toContain('/plugin/schedule/api');
      for (const param of endpoint.params ?? []) {
        expect(param.name).toMatch(/^\w+$/);
        expect(param.description.length).toBeGreaterThan(0);
        expect(param.type.length).toBeGreaterThan(0);
      }
    }
    // 写入端点必须把 body 参数写全，模型只靠这份文档调用
    expect(handler.endpoints[1].params?.map((param) => param.name)).toEqual(['name', 'start', 'end', 'color', 'note']);
    expect(handler.endpoints[2].params?.map((param) => param.name)).toEqual([
      'id',
      'name',
      'start',
      'end',
      'color',
      'note',
    ]);
    expect(handler.guide).toContain('/overview');
  });
});

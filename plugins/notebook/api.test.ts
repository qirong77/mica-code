import { describe, expect, it } from 'vitest';
import {
  PluginApiError,
  type PluginApiHandler,
  type PluginApiMethod,
  type PluginDataApi,
} from '@packages/mica-plugin/index.js';
import createApi from './api';
import type { NotebookDocument } from './model';
import { notebookText } from './service';

type Stored = { value: unknown; version: string | null };

function clone<T>(value: T): T {
  return value === null || value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function memoryData() {
  let index: Stored = { value: null, version: null };
  let counter = 0;
  const documents = new Map<string, Stored>();
  const next = (prefix: string) => `${prefix}-${++counter}`;
  const data = {
    read: () => clone(index),
    write: (value: unknown, options: { expectedVersion?: string | null } = {}) => {
      if (options.expectedVersion !== index.version) return { ok: false, conflict: true };
      index = { value: clone(value), version: next('index') };
      return { ok: true, version: index.version };
    },
    documents: {
      read: (key: string) => clone(documents.get(key) ?? { value: null, version: null }),
      write: (key: string, value: NotebookDocument, options: { expectedVersion?: string | null } = {}) => {
        const current = documents.get(key) ?? { value: null, version: null };
        if (options.expectedVersion !== current.version) return { ok: false, conflict: true };
        const stored = { value: clone(value), version: next(`document-${key}`) };
        documents.set(key, stored);
        return { ok: true, version: stored.version };
      },
    },
    externalDocument(key: string, value: NotebookDocument) {
      documents.set(key, { value: clone(value), version: next(`external-${key}`) });
    },
  };
  return data;
}

function createHandler() {
  const data = memoryData();
  const handler = createApi({
    pluginId: 'notebook',
    pluginVersion: '1.5.0',
    data: data as unknown as PluginDataApi,
    settings: { get: () => ({}) },
  });
  return { data, handler };
}

async function request(
  handler: PluginApiHandler,
  method: PluginApiMethod,
  path: string,
  options: { query?: Record<string, string>; body?: unknown } = {},
): Promise<Record<string, any>> {
  const response = await handler.handle({
    method,
    path: path.split('/').filter(Boolean),
    query: options.query ?? {},
    body: options.body,
    signal: new AbortController().signal,
  });
  return response.body as Record<string, any>;
}

async function expectFailure(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<PluginApiError> {
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

describe('Notebook plugin API', () => {
  it('keeps native soft breaks and code blank lines in its readable text projection', () => {
    const text = notebookText(
      JSON.stringify({
        root: {
          type: 'root',
          children: [
            {
              type: 'paragraph',
              children: [{ type: 'text', text: '第一行' }, { type: 'linebreak' }, { type: 'text', text: '第二行' }],
            },
            {
              type: 'code',
              language: 'js',
              children: [
                { type: 'text', text: 'const ok = true;' },
                { type: 'linebreak' },
                { type: 'linebreak' },
                { type: 'text', text: 'console.log(ok);' },
              ],
            },
          ],
        },
      }),
    );
    expect(text).toContain('第一行\n第二行');
    expect(text).toContain('const ok = true;\n\nconsole.log(ok);');
  });

  it('documents itself: endpoint table, params and the calling rules', () => {
    const { handler } = createHandler();

    expect(String(handler.description)).toContain('/plugin/notebook/api');
    expect(String(handler.guide)).toContain('不可信');
    expect(String(handler.guide)).toContain('expected_version');
    expect(String(handler.guide)).toContain('409');
    expect(String(handler.guide)).toContain('restore');
    expect(String(handler.guide)).toContain('$MICA_HOME/plugin-data/notebook/');

    const expected: [PluginApiMethod, string][] = [
      ['GET', '/overview'],
      ['GET', '/notes'],
      ['GET', '/notes/:id'],
      ['GET', '/search'],
      ['POST', '/folders'],
      ['POST', '/notes'],
      ['PATCH', '/notes/:id'],
      ['DELETE', '/notes/:id'],
      ['POST', '/notes/:id/restore'],
      ['POST', '/notes/:id/content'],
    ];
    expect(handler.endpoints.map((endpoint) => [endpoint.method, endpoint.path])).toEqual(expected);
    for (const endpoint of handler.endpoints) {
      expect(endpoint.path.startsWith('/')).toBe(true);
      // 模型先看 summary 与 params.description 决定怎么调，所以两者都得说清副作用。
      expect(endpoint.summary.length).toBeGreaterThan(10);
      expect(endpoint.returns.length).toBeGreaterThan(10);
      expect(String(endpoint.example)).toContain('/plugin/notebook/api');
      for (const param of endpoint.params ?? []) {
        expect(['path', 'query', 'body']).toContain(param.in);
        expect(param.name.length).toBeGreaterThan(0);
        expect(param.type.length).toBeGreaterThan(0);
        expect(param.description.length).toBeGreaterThan(4);
      }
    }
    const content = handler.endpoints.find((endpoint) => endpoint.path === '/notes/:id/content');
    expect(content?.params).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'expected_version', in: 'body', required: true }),
        expect.objectContaining({ name: 'mode', in: 'body', required: true }),
      ]),
    );
  });

  it('serves an overview with tree, counts, trash and the endpoint table', async () => {
    const { handler } = createHandler();
    const folder = (await request(handler, 'POST', '/folders', { body: { title: '工作' } })).node;
    const note = (await request(handler, 'POST', '/notes', { body: { title: '会议', parent_id: folder.id } })).node;
    const rootNote = (await request(handler, 'POST', '/notes', { body: { title: '根笔记' } })).node;

    const overview = await request(handler, 'GET', '/overview');
    expect(overview.notebook).toEqual({ name: 'Notebook', version: '1.5.0', api: '/plugin/notebook/api' });
    expect(overview.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(overview.counts).toEqual({ folders: 1, notes: 2, trashed: 0 });
    expect(overview.tree).toMatchObject([
      {
        id: folder.id,
        node_id: folder.id,
        kind: 'folder',
        title: '工作',
        path: ['工作'],
        parent_id: null,
        trashed: false,
        children: [{ id: note.id, kind: 'note', title: '会议', path: ['工作', '会议'], parent_id: folder.id }],
      },
      { id: rootNote.id, kind: 'note', title: '根笔记', path: ['根笔记'], parent_id: null },
    ]);
    expect(overview.tree[1]).not.toHaveProperty('children');
    expect(overview.trashed).toEqual([]);
    expect(overview.endpoints).toHaveLength(handler.endpoints.length);
    expect(overview.endpoints[0]).toMatchObject({ method: 'GET', path: '/overview' });
    for (const endpoint of overview.endpoints) expect(Object.keys(endpoint).sort()).toEqual(['method', 'path', 'summary']);
    // 默认概览不读任何正文。
    expect(overview.tree[0].children[0]).not.toHaveProperty('version');

    await request(handler, 'POST', `/notes/${rootNote.id}/content`, {
      body: { mode: 'set_text', text: '可读正文', expected_version: null },
    });
    const withDocuments = await request(handler, 'GET', '/overview', { query: { documents: 'true' } });
    expect(withDocuments.tree[0].children[0]).toMatchObject({ id: note.id, version: null, characters: 0 });
    expect(withDocuments.tree[1]).toMatchObject({ id: rootNote.id, characters: 4 });
    expect(typeof withDocuments.tree[1].version).toBe('string');

    await request(handler, 'DELETE', `/notes/${rootNote.id}`);
    const afterTrash = await request(handler, 'GET', '/overview');
    expect(afterTrash.counts).toEqual({ folders: 1, notes: 1, trashed: 1 });
    expect(afterTrash.trashed).toMatchObject([{ id: rootNote.id, title: '根笔记', trashed: true }]);
    expect(typeof afterTrash.trashed[0].trashed_at).toBe('string');
    expect(afterTrash.tree.map((node: Record<string, any>) => node.id)).toEqual([folder.id]);
  });

  it('runs the whole read/write/edit/organize flow through the documented endpoints', async () => {
    const { handler } = createHandler();
    const folder = (await request(handler, 'POST', '/folders', { body: { title: '工作' } })).node;
    const created = await request(handler, 'POST', '/notes', {
      body: { title: '会议', parent_id: folder.id, markdown: '# 会议\n\n## 结论\n\nalpha alpha' },
    });
    const note = created.node;
    expect(created).toMatchObject({ format: 'markdown', blocks: 3, outline: ['会议', '结论'], warnings: [] });
    expect(created).not.toHaveProperty('text');

    const text = await request(handler, 'GET', `/notes/${note.id}`);
    expect(text).toMatchObject({ node: { id: note.id }, missing: false, text_truncated: false, version: created.version });
    expect(text.text).toContain('结论');
    expect(text.text).toContain('alpha alpha');
    expect(text).not.toHaveProperty('editor_state');

    const lexical = await request(handler, 'GET', `/notes/${note.id}`, { query: { format: 'lexical' } });
    expect(JSON.parse(lexical.editor_state).root.children.map((child: Record<string, unknown>) => child.type)).toEqual([
      'heading',
      'heading',
      'paragraph',
    ]);

    const children = await request(handler, 'GET', '/notes', { query: { parent_id: folder.id } });
    expect(children.nodes).toMatchObject([{ id: note.id, kind: 'note', path: ['工作', '会议'] }]);
    const folderRead = await request(handler, 'GET', `/notes/${folder.id}`);
    expect(folderRead.node).toMatchObject({ id: folder.id, kind: 'folder' });
    expect(folderRead.children).toMatchObject([{ id: note.id }]);

    const appended = await request(handler, 'POST', `/notes/${note.id}/content`, {
      body: { mode: 'append_markdown', markdown: '## 后记', expected_version: lexical.version },
    });
    expect(appended).toMatchObject({ format: 'markdown', blocks: 1, warnings: [] });
    expect(appended).not.toHaveProperty('text');
    const prepended = await request(handler, 'POST', `/notes/${note.id}/content`, {
      body: { mode: 'prepend_markdown', markdown: '摘要', expected_version: appended.version },
    });
    expect(prepended).toMatchObject({ format: 'markdown', blocks: 1 });

    const ambiguous = await expectFailure(
      request(handler, 'POST', `/notes/${note.id}/content`, {
        body: { mode: 'replace_text', find: 'alpha', replace: 'omega', expected_version: prepended.version },
      }),
      400,
      'invalid_request',
    );
    expect(ambiguous.message).toContain('replace_all');
    const replaced = await request(handler, 'POST', `/notes/${note.id}/content`, {
      body: {
        mode: 'replace_text',
        find: 'alpha',
        replace: 'omega',
        replace_all: true,
        expected_version: prepended.version,
      },
    });
    expect(replaced).toMatchObject({ replacements: 2 });
    expect(replaced.text).toContain('omega omega');

    const written = await request(handler, 'POST', `/notes/${note.id}/content`, {
      body: { mode: 'set_text', text: '纯文本正文', expected_version: replaced.version },
    });
    expect(written).toMatchObject({ text: '纯文本正文', missing: false });
    const editorState = JSON.stringify({ root: { children: [{ type: 'paragraph', children: [{ text: 'rich' }] }] } });
    const rich = await request(handler, 'POST', `/notes/${note.id}/content`, {
      body: { mode: 'set_editor_state', editor_state: editorState, expected_version: written.version },
    });
    expect(await request(handler, 'GET', `/notes/${note.id}`, { query: { format: 'lexical' } })).toMatchObject({
      version: rich.version,
      editor_state: editorState,
    });
    const set = await request(handler, 'POST', `/notes/${note.id}/content`, {
      body: { mode: 'set_markdown', markdown: '# 标题\n\n- 一项', expected_version: rich.version },
    });
    expect(set).toMatchObject({ format: 'markdown', blocks: 2, outline: ['标题'] });

    const renamed = await request(handler, 'PATCH', `/notes/${note.id}`, { body: { title: '会议纪要' } });
    expect(renamed.node).toMatchObject({ id: note.id, title: '会议纪要' });
    const moved = await request(handler, 'PATCH', `/notes/${note.id}`, { body: { parent_id: null } });
    expect(moved.node).toMatchObject({ id: note.id, parent_id: null, path: ['会议纪要'] });

    const searched = await request(handler, 'GET', '/search', { query: { q: '会议纪要' } });
    expect(searched.query).toBe('会议纪要');
    expect(searched.matches[0]).toMatchObject({ node: { id: note.id }, fields: ['title', 'path'] });

    const trashed = await request(handler, 'DELETE', `/notes/${note.id}`);
    expect(trashed.node).toMatchObject({ id: note.id, trashed: true });
    expect(trashed.affected_ids).toContain(note.id);
    expect((await request(handler, 'GET', '/notes')).nodes).not.toContainEqual(
      expect.objectContaining({ id: note.id }),
    );
    expect((await request(handler, 'GET', '/notes', { query: { include_trash: 'true' } })).nodes).toMatchObject([
      { id: note.id, trashed: true },
    ]);

    const restored = await request(handler, 'POST', `/notes/${note.id}/restore`);
    expect(restored).toMatchObject({ node: { id: note.id, trashed: false } });
    expect(restored.restored_ids).toContain(note.id);
    expect((await request(handler, 'GET', '/notes')).nodes).toContainEqual(
      expect.objectContaining({ id: note.id, trashed: false }),
    );
  });

  it('maps missing nodes, stale versions and invalid input to stable error codes', async () => {
    const { handler } = createHandler();
    const note = (await request(handler, 'POST', '/notes', { body: { title: '边界' } })).node;
    const folder = (await request(handler, 'POST', '/folders', { body: { title: '目录' } })).node;

    const missing = await expectFailure(request(handler, 'GET', '/notes/does-not-exist'), 404, 'not_found');
    expect(missing.message).toContain('/overview');

    await expectFailure(
      request(handler, 'POST', '/notes/missing/content', {
        body: { mode: 'set_text', text: 'x', expected_version: null },
      }),
      404,
      'not_found',
    );

    const noVersion = await expectFailure(
      request(handler, 'POST', `/notes/${note.id}/content`, { body: { mode: 'set_text', text: 'x' } }),
      400,
      'invalid_request',
    );
    expect(noVersion.message).toContain('expected_version');

    const badMode = await expectFailure(
      request(handler, 'POST', `/notes/${note.id}/content`, {
        body: { mode: 'rewrite', text: 'x', expected_version: null },
      }),
      400,
      'invalid_request',
    );
    expect(badMode.message).toContain('set_markdown');

    const first = await request(handler, 'POST', `/notes/${note.id}/content`, {
      body: { mode: 'set_text', text: '本地', expected_version: null },
    });
    expect(typeof first.version).toBe('string');

    const stale = await expectFailure(
      request(handler, 'POST', `/notes/${note.id}/content`, {
        body: { mode: 'set_text', text: '过期', expected_version: null },
      }),
      409,
      'version_conflict',
    );
    expect(stale.message).toContain('重新读取');
    expect((await request(handler, 'GET', `/notes/${note.id}`)).text).toBe('本地');

    const onFolder = await expectFailure(
      request(handler, 'POST', `/notes/${folder.id}/content`, {
        body: { mode: 'set_text', text: 'x', expected_version: null },
      }),
      400,
      'invalid_request',
    );
    expect(onFolder.message).toContain('文件夹');

    const trashedNote = (await request(handler, 'POST', '/notes', { body: { title: '待删', markdown: '正文' } })).node;
    const trashedSnapshot = await request(handler, 'GET', `/notes/${trashedNote.id}`);
    await request(handler, 'DELETE', `/notes/${trashedNote.id}`);
    const onTrashed = await expectFailure(
      request(handler, 'POST', `/notes/${trashedNote.id}/content`, {
        body: { mode: 'set_text', text: 'x', expected_version: trashedSnapshot.version },
      }),
      400,
      'invalid_request',
    );
    expect(onTrashed.message).toContain('restore');

    const noQuery = await expectFailure(request(handler, 'GET', '/search'), 400, 'invalid_request');
    expect(noQuery.message).toContain('q');

    await expectFailure(request(handler, 'GET', '/notes', { query: { include_trash: 'yes' } }), 400, 'invalid_request');
    await expectFailure(request(handler, 'GET', `/notes/${note.id}`, { query: { format: 'html' } }), 400, 'invalid_request');

    const missingTitle = await expectFailure(
      request(handler, 'POST', '/folders', { body: { parent_id: null } }),
      400,
      'invalid_request',
    );
    expect(missingTitle.message).toContain('title');

    await expectFailure(request(handler, 'PATCH', `/notes/${note.id}`, { body: {} }), 400, 'invalid_request');

    const badParent = await expectFailure(
      request(handler, 'GET', '/notes', { query: { parent_id: note.id } }),
      400,
      'invalid_request',
    );
    expect(badParent.message).toContain('文件夹');

    await expectFailure(request(handler, 'GET', '/sessions'), 404, 'not_found');

    await expectFailure(
      request(handler, 'POST', `/notes/${note.id}/content`, {
        body: { mode: 'set_editor_state', editor_state: '{broken', expected_version: first.version },
      }),
      400,
      'invalid_request',
    );
  });

  it('keeps storage failures opaque instead of leaking the underlying error', async () => {
    const { data, handler } = createHandler();
    const note = (await request(handler, 'POST', '/notes', { body: { title: '坏盘' } })).node;
    data.read = (() => ({
      value: null,
      version: null,
      ok: false,
      error: 'disk on fire at /Users/somebody',
    })) as unknown as typeof data.read;

    const failed = await expectFailure(request(handler, 'GET', '/overview'), 500, 'storage_error');
    expect(failed.message).not.toContain('disk on fire');
    expect(failed.message).not.toContain('/Users');

    await expectFailure(
      request(handler, 'POST', `/notes/${note.id}/content`, {
        body: { mode: 'set_text', text: 'x', expected_version: null },
      }),
      500,
      'storage_error',
    );
  });
});

import { describe, expect, it } from 'vitest';
import { COMPONENT_TEMPLATES } from '@packages/mica-editor/componentCatalog.js';
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
    pluginVersion: '1.7.0',
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

  it('documents itself as a book: root is an index and modules hold the details', async () => {
    const { handler } = createHandler();

    expect(String(handler.description)).toContain('/plugin/notebook/api');
    expect(String(handler.description)).toContain('目录');
    expect(String(handler.guide)).toContain('不可信');
    expect(String(handler.guide)).toContain('expected_version');
    expect(String(handler.guide)).toContain('409');
    expect(String(handler.guide)).toContain('restore');
    expect(String(handler.guide)).toContain('$MICA_HOME/plugin-data/notebook/');

    const expected: [PluginApiMethod, string][] = [
      ['GET', '/guide'],
      ['GET', '/modules'],
      ['GET', '/modules/:module'],
      ['GET', '/overview'],
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

    const guide = await request(handler, 'GET', '/guide');
    expect(guide.modules.map((module: Record<string, any>) => module.id)).toEqual(['tree', 'content', 'blocks']);
    expect(guide.modules[0].path).toBe('/plugin/notebook/api/modules/tree');
    expect(guide.recipes.length).toBeGreaterThanOrEqual(4);
    expect(guide.conventions.join('\n')).toContain('expected_version');
    expect(guide.how_to_read.join('\n')).toContain('/modules/<id>');

    // 根目录只给模块清单与端点摘要，不展开参数。
    const index = await request(handler, 'GET', '/modules');
    expect(index.modules.map((module: Record<string, any>) => module.id)).toEqual(['tree', 'content', 'blocks']);
    const listed = index.modules.find((module: Record<string, any>) => module.id === 'blocks');
    const blockRoutes = [
      ['GET', '/notes/:id/blocks'],
      ['POST', '/notes/:id/blocks'],
      ['PATCH', '/notes/:id/blocks/:block_id'],
    ];
    expect(listed.endpoints.map(({ method, path }: Record<string, string>) => [method, path])).toEqual(
      expect.arrayContaining(blockRoutes),
    );
    for (const endpoint of listed.endpoints) {
      expect(Object.keys(endpoint).sort()).toEqual(['method', 'path', 'summary']);
    }

    const blocks = await request(handler, 'GET', '/modules/blocks');
    expect(blocks.module.title).toContain('组件块');
    expect(blocks.module.path).toBe('/plugin/notebook/api/modules/blocks');
    expect(blocks.guide).toContain('function App({React, Arco, html})');
    expect(blocks.guide).toContain('rgb(var(--primary-6))');
    expect(blocks.guide).toContain('1200px');
    expect(blocks.guide).toContain('没有 JSX');
    expect(blocks.guide).toContain('没有 import');
    expect(blocks.guide).toContain('fetch');
    expect(blocks.guide).not.toMatch(/^```(?:js|jsx|javascript)$/m);
    expect(blocks.guide).toContain('block_id');
    expect(blocks.guide).toContain('expected_version');
    expect(blocks.templates).toEqual(
      COMPONENT_TEMPLATES.map(({ id, name, description, capabilities }) => ({
        id,
        name,
        description,
        capabilities,
        path: `/plugin/notebook/api/modules/blocks/templates/${id}`,
      })),
    );
    expect(blocks.guide).not.toContain(COMPONENT_TEMPLATES[0].code);
    expect(blocks.endpoints.map(({ method, path }: Record<string, string>) => [method, path])).toEqual(
      expect.arrayContaining(blockRoutes),
    );
    for (const [method, path] of blockRoutes) {
      const doc = blocks.endpoints.find((item: Record<string, string>) => item.path === path && item.method === method);
      const required = doc.params
        .filter((p: Record<string, unknown>) => p.required)
        .map((p: { name: string }) => p.name);
      expect(required).toEqual(
        method === 'GET'
          ? ['id']
          : method === 'POST'
            ? ['id', 'expected_version']
            : ['id', 'block_id', 'source', 'expected_version'],
      );
    }
    const steps = blocks.recipes.flatMap((recipe: { steps: string[] }) => recipe.steps).join('\n');
    expect(steps).toContain('GET /notes/:id/blocks');
    expect(steps).toContain('PATCH /notes/:id/blocks/:block_id');
    // In particular, a Markdown recipe must use JSON \n escapes, not raw newlines inside a quoted string.
    expect(guide.recipes).toEqual(expect.arrayContaining(blocks.recipes));
    for (const recipe of guide.recipes) {
      if (!recipe.curl) continue;
      const body = / -d '([\s\S]+)'$/.exec(recipe.curl)?.[1];
      expect(body).toBeDefined();
      expect(() => JSON.parse(body!.replaceAll("'\\''", "'"))).not.toThrow();
    }
    expect(blocks.next).toEqual(['/plugin/notebook/api/modules/content', '/plugin/notebook/api/modules/tree']);

    const content = blocks.endpoints.find((endpoint: Record<string, any>) => endpoint.path === '/notes/:id/content');
    expect(content?.params).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'expected_version', in: 'body', required: true }),
        expect.objectContaining({ name: 'mode', in: 'body', required: true }),
      ]),
    );

    await expectFailure(request(handler, 'GET', '/modules/unknown'), 404, 'module_not_found');
    await expectFailure(request(handler, 'GET', '/modules/blocks/templates/unknown'), 404, 'template_not_found');
  });

  it('serves an overview with tree, counts, trash and links to the docs', async () => {
    const { handler } = createHandler();
    const folder = (await request(handler, 'POST', '/folders', { body: { title: '工作' } })).node;
    const note = (await request(handler, 'POST', '/notes', { body: { title: '会议', parent_id: folder.id } })).node;
    const rootNote = (await request(handler, 'POST', '/notes', { body: { title: '根笔记' } })).node;

    const overview = await request(handler, 'GET', '/overview');
    expect(overview.notebook).toEqual({ name: 'Notebook', version: '1.7.0', api: '/plugin/notebook/api' });
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
    expect(overview.docs.guide).toBe('/plugin/notebook/api/guide');
    expect(overview.docs.modules.map((module: Record<string, any>) => module.id)).toEqual([
      'tree',
      'content',
      'blocks',
    ]);
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

  it('clones a rich note without round-tripping Markdown, and exposes image metadata separately', async () => {
    const { handler } = createHandler();
    const source = (await request(handler, 'POST', '/notes', { body: { title: '原稿' } })).node;
    const editorState = JSON.stringify({
      root: {
        type: 'root',
        children: [
          { type: 'heading', tag: 'h1', children: [{ type: 'text', text: '原稿' }] },
          { type: 'image', src: 'data:image/png;base64,iVBORw0KGgo=', altText: '截图', width: 640, maxWidth: 720, showCaption: true },
          { type: 'paragraph', children: [{ type: 'text', text: '正文' }] },
        ],
      },
    });
    const written = await request(handler, 'POST', `/notes/${source.id}/content`, {
      body: { mode: 'set_editor_state', editor_state: editorState, expected_version: null },
    });

    const assets = await request(handler, 'GET', `/notes/${source.id}/assets`);
    expect(assets).toMatchObject({ version: written.version, summary: { images: 1, inline_images: 1 } });
    expect(assets.assets).toEqual([
      expect.objectContaining({ asset_id: 'image:1', path: [1], kind: 'inline', alt_text: '截图', width: 640 }),
    ]);
    const validation = await request(handler, 'GET', `/notes/${source.id}/validate`);
    expect(validation).toMatchObject({ valid: true, version: written.version, summary: { images: 1 } });

    const clone = await request(handler, 'POST', `/notes/${source.id}/clone`, { body: { title: '整理版' } });
    expect(clone).toMatchObject({ node: { title: '整理版' }, source: { id: source.id }, missing: false });
    expect(clone.version).toBeTypeOf('string');
    const cloned = await request(handler, 'GET', `/notes/${clone.node.id}`, { query: { format: 'lexical' } });
    expect(JSON.parse(cloned.editor_state)).toEqual(JSON.parse(editorState));
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
    expect(text).toMatchObject({
      node: { id: note.id },
      missing: false,
      text_truncated: false,
      version: created.version,
    });
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

  it('reads, appends, prepends and updates blocks without round-tripping Lexical', async () => {
    const { handler } = createHandler();
    const note = (await request(handler, 'POST', '/notes', { body: { title: '组件块' } })).node;
    const initialState = JSON.stringify({
      root: {
        type: 'root',
        version: 1,
        children: [
          { type: 'paragraph', version: 1, children: [{ type: 'text', text: '正文' }] },
          {
            type: 'quote',
            version: 1,
            children: [{ type: 'component', version: 1, code: 'function App() { return null; }', height: 321 }],
          },
          { type: 'html', version: 1, html: '<div>旧 HTML</div>', format: 'keep-me' },
        ],
      },
    });
    const seeded = await request(handler, 'POST', `/notes/${note.id}/content`, {
      body: { mode: 'set_editor_state', editor_state: initialState, expected_version: null },
    });

    const listed = await request(handler, 'GET', `/notes/${note.id}/blocks`);
    expect(listed).toMatchObject({ node: { id: note.id }, version: seeded.version });
    expect(listed.blocks).toEqual([
      { block_id: '1.0', path: [1, 0], type: 'component', source: 'function App() { return null; }' },
      { block_id: '2', path: [2], type: 'html', source: '<div>旧 HTML</div>' },
    ]);

    const patched = await request(handler, 'PATCH', `/notes/${note.id}/blocks/1.0`, {
      body: { source: 'function App() { return html`<p>新组件</p>`; }', expected_version: listed.version },
    });
    expect(patched.block).toMatchObject({
      block_id: '1.0',
      type: 'component',
      source: 'function App() { return html`<p>新组件</p>`; }',
    });
    const lexical = await request(handler, 'GET', `/notes/${note.id}`, { query: { format: 'lexical' } });
    const expectedState = JSON.parse(initialState);
    expectedState.root.children[1].children[0].code = patched.block.source;
    expect(JSON.parse(lexical.editor_state)).toEqual(expectedState);

    const appended = await request(handler, 'POST', `/notes/${note.id}/blocks`, {
      body: {
        type: 'component',
        source: COMPONENT_TEMPLATES[0].code,
        position: 'append',
        expected_version: patched.version,
      },
    });
    expect(appended.block).toMatchObject({ block_id: '3', type: 'component', source: COMPONENT_TEMPLATES[0].code });
    const prepended = await request(handler, 'POST', `/notes/${note.id}/blocks`, {
      body: { type: 'html', source: '<aside>新块</aside>', position: 'prepend', expected_version: appended.version },
    });
    expect(prepended.block).toMatchObject({ block_id: '0', type: 'html', source: '<aside>新块</aside>' });
    expect((await request(handler, 'GET', `/notes/${note.id}/blocks`)).blocks).toEqual([
      { block_id: '0', path: [0], type: 'html', source: '<aside>新块</aside>' },
      { block_id: '2.0', path: [2, 0], type: 'component', source: 'function App() { return html`<p>新组件</p>`; }' },
      { block_id: '3', path: [3], type: 'html', source: '<div>旧 HTML</div>' },
      { block_id: '4', path: [4], type: 'component', source: COMPONENT_TEMPLATES[0].code },
    ]);

    await expectFailure(
      request(handler, 'PATCH', `/notes/${note.id}/blocks/3`, {
        body: { source: '<div>不应覆盖</div>', expected_version: appended.version },
      }),
      409,
      'version_conflict',
    );
    for (const [blockId, reason] of [
      ['1..0', '不合法'],
      ['-1', '不合法'],
      ['01', '不合法'],
      ['99', '不存在'],
      ['1', '不是组件块'],
    ]) {
      const error = await expectFailure(
        request(handler, 'PATCH', `/notes/${note.id}/blocks/${blockId}`, {
          body: { source: '<div>更新</div>', expected_version: prepended.version },
        }),
        400,
        'invalid_request',
      );
      expect(error.message).toContain(reason);
    }
    await expectFailure(
      request(handler, 'POST', `/notes/${note.id}/blocks`, {
        body: { type: 'html', source: '   ', position: 'append', expected_version: prepended.version },
      }),
      400,
      'invalid_request',
    );
  });

  it('writes every catalog entry using the Markdown returned by its advertised URL', async () => {
    const { handler } = createHandler();
    const { templates, guide } = await request(handler, 'GET', '/modules/blocks');
    const markdown = [guide.match(/^```react\n[\s\S]*?\n```$/m)[0]];
    for (const [i, entry] of templates.entries()) {
      const detail = await request(handler, 'GET', entry.path.slice('/plugin/notebook/api'.length));
      expect(detail).toMatchObject({
        id: entry.id,
        capabilities: COMPONENT_TEMPLATES[i].capabilities,
        source: COMPONENT_TEMPLATES[i].code,
      });
      markdown.push(detail.markdown);
    }
    const created = await request(handler, 'POST', '/notes', {
      body: { title: '模板目录', markdown: markdown.join('\n\n') },
    });
    expect(created).toMatchObject({ statistics: { component_blocks: templates.length + 1 }, warnings: [] });
    const listed = await request(handler, 'GET', `/notes/${created.node.id}/blocks`);
    expect(listed.blocks.slice(1)).toEqual(
      COMPONENT_TEMPLATES.map(({ code: source }, i) => ({
        block_id: String(i + 1),
        path: [i + 1],
        type: 'component',
        source,
      })),
    );
  });

  it('inserts a template as an independent source snapshot after the fixed title, never resolving ambiguous input', async () => {
    const { handler } = createHandler();
    const { node, version } = await request(handler, 'POST', '/notes', {
      body: { title: '预算', markdown: '# 预算\n\n下文' },
    });
    const path = `/notes/${node.id}/blocks`;
    const template = COMPONENT_TEMPLATES.find((item) => item.id === 'calculator')!;
    const body = { template_id: template.id, expected_version: version, position: 'prepend' };
    for (const bad of [{ source: '正文' }, { type: 'html' }, { template_id: 'unknown' }, { template_id: null }]) {
      await expectFailure(request(handler, 'POST', path, { body: { ...body, ...bad } }), 400, 'invalid_request');
    }
    const added = await request(handler, 'POST', path, { body });
    expect(added.block).toEqual({ block_id: '1', path: [1], type: 'component', source: template.code });
    const snapshot = await request(handler, 'GET', `/notes/${node.id}`, { query: { format: 'lexical' } });
    const nodes = JSON.parse(snapshot.editor_state).root.children;
    expect(nodes.map((n: { type: string }) => n.type)).toEqual(['heading', 'component', 'paragraph']);
    expect(nodes[1]).not.toHaveProperty('template_id');
  });

  it('writes a first block on null editorState and uses the document CAS without overwriting another writer', async () => {
    const { handler, data } = createHandler();
    const { node } = await request(handler, 'POST', '/notes', { body: { title: '空笔记' } });
    const path = `/notes/${node.id}/blocks`;
    expect(await request(handler, 'GET', path)).toEqual({ node, version: null, blocks: [] });
    const source = '  <aside>草稿</aside>\n';
    const insert = { type: 'html', position: 'append', source, expected_version: null };
    for (const body of [{ ...insert, type: 'code' }, { ...insert, position: 'before' }, { source }]) {
      await expectFailure(request(handler, 'POST', path, { body }), 400, 'invalid_request');
    }
    const first = await request(handler, 'POST', path, { body: insert });
    expect(first.block).toEqual({ type: 'html', source, path: [0], block_id: '0' });
    expect(data.documents.read(node.id).value).toMatchObject({ version: 1 });
    await expectFailure(request(handler, 'POST', path, { body: insert }), 409, 'version_conflict');
    const edit = { source: '<section>已确认</section>', expected_version: first.version };
    await expectFailure(
      request(handler, 'PATCH', `${path}/0`, { body: { ...edit, source: '' } }),
      400,
      'invalid_request',
    );
    const updated = await request(handler, 'PATCH', `${path}/0`, { body: edit });
    expect(updated.block).toEqual({ ...first.block, source: edit.source });

    // Disk changed after updateDocument read but before saveDocument attempted its versioned write.
    const write = data.documents.write;
    const external = { root: { children: [{ type: 'html', html: '<p>另一窗口写入</p>', version: 1 }] } };
    data.documents.write = (id, value, options) => {
      data.externalDocument(id, { version: 1, editorState: JSON.stringify(external) });
      return write(id, value, options);
    };
    await expectFailure(
      request(handler, 'PATCH', `${path}/0`, { body: { ...edit, expected_version: updated.version } }),
      409,
      'version_conflict',
    );
    expect((await request(handler, 'GET', path)).blocks).toEqual([
      { ...first.block, source: external.root.children[0].html },
    ]);
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

    const malformedEditorState = await expectFailure(
      request(handler, 'POST', `/notes/${note.id}/content`, {
        body: { mode: 'set_editor_state', editor_state: JSON.stringify({ root: { children: 'not-an-array' } }), expected_version: null },
      }),
      400,
      'invalid_request',
    );
    expect(malformedEditorState.message).toContain('children');

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
    await expectFailure(
      request(handler, 'GET', `/notes/${note.id}`, { query: { format: 'html' } }),
      400,
      'invalid_request',
    );

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

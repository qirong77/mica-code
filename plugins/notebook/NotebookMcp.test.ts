import { describe, expect, it } from 'vitest';
import type { PluginDataApi, PluginMcpTool } from '@packages/mica-plugin/index.js';
import createMcp from './mcp';
import type { NotebookDocument } from './model';

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

function createTools() {
  const data = memoryData();
  const handler = createMcp({
    pluginId: 'notebook',
    data: data as unknown as PluginDataApi,
    settings: { get: () => ({}) },
  });
  const read = handler.tools.find((tool) => tool.name === 'notebook_read');
  const write = handler.tools.find((tool) => tool.name === 'notebook_write');
  if (!read || !write) throw new Error('Notebook MCP tools were not registered');
  return { data, handler, read, write };
}

async function call(tool: PluginMcpTool, input: Record<string, unknown>): Promise<string> {
  const result = await tool.execute(input, { signal: new AbortController().signal });
  if (typeof result !== 'string') throw new Error('Notebook MCP test expected JSON text output');
  return result;
}

function json(value: string): Record<string, any> {
  return JSON.parse(value) as Record<string, any>;
}

describe('Notebook MCP', () => {
  it('describes the two tools, their safety annotations and the local-data rules', () => {
    const { handler, read, write } = createTools();

    expect(handler.tools.map((tool) => tool.name)).toEqual(['notebook_read', 'notebook_write']);
    expect(handler.instructions).toContain('/plugin/notebook/mcp');
    expect(handler.instructions).toContain('不可信的用户数据');
    expect(handler.instructions).toContain('expected_version');
    expect(read.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(write.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
    expect(read.inputSchema).toMatchObject({ required: ['operation'] });
    expect(write.inputSchema).toMatchObject({ required: ['operation'] });
    expect(String(read.description)).toContain('node_id');
    expect(String(write.description)).toContain('expected_version');
  });

  it('supports every read and write operation through the MCP tools', async () => {
    const { read, write } = createTools();
    const folder = json(await call(write, { operation: 'create_folder', title: '工作' }));
    const note = json(await call(write, { operation: 'create_note', title: '会议', parent_id: folder.id }));

    expect(json(await call(read, { operation: 'list' })).nodes).toMatchObject([
      { id: folder.id, node_id: folder.id, kind: 'folder', path: ['工作'] },
      { id: note.id, node_id: note.id, kind: 'note', path: ['工作', '会议'] },
    ]);
    expect(json(await call(read, { operation: 'search', query: '会议' })).matches[0]).toMatchObject({
      node: { id: note.id },
      fields: ['title', 'path'],
    });
    expect(json(await call(read, { operation: 'read', node_id: folder.id })).children[0]).toMatchObject({ id: note.id });

    const renamed = json(await call(write, { operation: 'rename', node_id: note.id, title: '会议纪要' }));
    expect(renamed.title).toBe('会议纪要');
    const moved = json(await call(write, { operation: 'move', node_id: note.id, parent_id: null }));
    expect(moved.parent_id).toBeNull();

    const first = json(await call(write, { operation: 'set_text', node_id: note.id, text: 'alpha alpha', expected_version: null }));
    const appended = json(await call(write, { operation: 'append_text', node_id: note.id, text: 'beta', expected_version: first.version }));
    const prepended = json(await call(write, { operation: 'prepend_text', node_id: note.id, text: 'start', expected_version: appended.version }));
    await expect(
      call(write, {
        operation: 'replace_text',
        node_id: note.id,
        find: 'alpha',
        replace: 'omega',
        expected_version: prepended.version,
      }),
    ).rejects.toThrow(/replace_all/);
    const replaced = json(await call(write, {
      operation: 'replace_text',
      node_id: note.id,
      find: 'alpha',
      replace: 'omega',
      replace_all: true,
      expected_version: prepended.version,
    }));
    expect(replaced.replacements).toBe(2);

    const editorState = JSON.stringify({ root: { children: [{ type: 'paragraph', children: [{ text: 'rich' }] }] } });
    const rich = json(await call(write, {
      operation: 'set_editor_state',
      node_id: note.id,
      editor_state: editorState,
      expected_version: replaced.version,
    }));
    const readBack = json(await call(read, { operation: 'read', node_id: note.id, include_editor_state: true }));
    expect(readBack.version).toBe(rich.version);
    expect(readBack.editor_state).toBe(editorState);
    expect(readBack.text).toContain('rich');

    const trashed = json(await call(write, { operation: 'trash', node_id: note.id }));
    expect(trashed.affected_ids).toContain(note.id);
    expect(json(await call(read, { operation: 'list' })).nodes).not.toContainEqual(expect.objectContaining({ id: note.id }));
    expect(json(await call(read, { operation: 'list', include_trash: true })).nodes[0]).toMatchObject({ id: note.id, trashed: true });
    const restored = json(await call(write, { operation: 'restore', node_id: note.id }));
    expect(restored.restored_ids).toContain(note.id);
    expect(json(await call(read, { operation: 'list' })).nodes).toContainEqual(expect.objectContaining({ id: note.id, trashed: false }));
  });

  it('rejects invalid business inputs and stale CAS writes without overwriting another writer', async () => {
    const { data, read, write } = createTools();
    const note = json(await call(write, { operation: 'create_note', title: '边界' }));

    await expect(call(read, { operation: 'search' })).rejects.toThrow(/缺少 query/);
    await expect(call(read, { operation: 'unknown' })).rejects.toThrow(/operation/);
    await expect(call(write, { operation: 'set_text', node_id: note.id, text: '缺少版本' })).rejects.toThrow(/expected_version/);
    await expect(call(write, { operation: 'set_editor_state', node_id: note.id, editor_state: '{broken', expected_version: null })).rejects.toThrow(/JSON/);

    const first = json(await call(write, { operation: 'set_text', node_id: note.id, text: '本地', expected_version: null }));
    data.externalDocument(note.id, { version: 1, editorState: JSON.stringify({ root: { children: [{ text: '另一个窗口' }] } }) });
    await expect(
      call(write, { operation: 'set_text', node_id: note.id, text: '过期', expected_version: first.version }),
    ).rejects.toThrow(/changed elsewhere|冲突/);
    expect(json(await call(read, { operation: 'read', node_id: note.id })).text).toContain('另一个窗口');
  });
});

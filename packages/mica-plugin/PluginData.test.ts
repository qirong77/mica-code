import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { micaCommands } from '@packages/mica-commands/index.js';
import { micaRuntime } from '@packages/mica-runtime/index.js';
import {
  PLUGIN_DATA_MAX_BYTES,
  PLUGIN_DOCUMENT_MAX_BYTES,
  createPluginDataApi,
  decodePluginData,
  encodePluginData,
  isValidPluginDocumentKey,
  pluginDataPath,
  readPluginData,
  writePluginData,
} from './PluginData.js';
import { HookRegistry } from './HookRegistry.js';
import { PluginManager } from './PluginManager.js';
import type { PluginBaseContext } from './PluginManager.js';
import type { PluginContext } from './PluginContext.js';
import { parsePluginManifest } from './PluginManifest.js';
import { ServiceContainer } from './ServiceContainer.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mica-plugin-data-'));
  vi.stubEnv('MICA_HOME', home);
  vi.stubEnv('MICA_PLUGIN_LOG', '0');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('shared plugin data', () => {
  it('binds data and independent documents to the plugin and returns the committed raw-byte hash', () => {
    const data = createPluginDataApi(home, 'sample');
    expect(data.read()).toEqual({ value: null, version: null });
    expect(data.documents.read('page')).toEqual({ value: null, version: null });
    const saved = data.write({ pages: ['page'] }, { expectedVersion: null });
    expect(saved.ok).toBe(true);
    const first = data.documents.write('page', { text: '正文' }, { expectedVersion: null });
    expect(first.ok).toBe(true);
    expect(data.documents.read('page')).toEqual({ value: { text: '正文' }, version: first.ok ? first.version : '' });
    expect(data.documents.write('other', false).ok).toBe(true);
    expect(data.documents.read('other').value).toBe(false);
    expect(data.read().value).toEqual({ pages: ['page'] });
    expect(createPluginDataApi(home, 'another').read().value).toBeNull();
    const file = pluginDataPath(home, 'sample', { key: 'page' })!;
    const raw = readFileSync(file, 'utf8');
    expect(raw).toBe('{"text":"正文"}\n');
    expect(first).toEqual({ ok: true, version: createHash('sha256').update(raw).digest('hex') });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it.each([undefined, 'page'])('rejects stale CAS and uses the existing cross-process lock (key=%s)', (key) => {
    const options = key === undefined ? {} : { key };
    const first = writePluginData(home, 'sample', 'first', { ...options, expectedVersion: null });
    if (!first.ok) throw new Error(first.error);
    const second = writePluginData(home, 'sample', 'second', { ...options, expectedVersion: first.version });
    expect(second.ok).toBe(true);
    expect(writePluginData(home, 'sample', 'stale', { ...options, expectedVersion: first.version }))
      .toMatchObject({ ok: false, conflict: true });
    expect(writePluginData(home, 'sample', 'not new', { ...options, expectedVersion: null }))
      .toMatchObject({ ok: false, conflict: true });
    expect(readPluginData(home, 'sample', options).value).toBe('second');
    const release = acquireProcessLock(`${pluginDataPath(home, 'sample', options)}.lock`);
    if (!release) throw new Error('Cannot acquire test lock');
    try {
      expect(writePluginData(home, 'sample', 'blocked', options)).toMatchObject({ ok: false, conflict: true });
    } finally {
      release();
    }
    expect(writePluginData(home, 'sample', 'after lock', options).ok).toBe(true);
  });

  it('refuses corrupt document reads and replacements even without CAS, cleaning up its lock', () => {
    const data = createPluginDataApi(home, 'sample');
    data.documents.write('page', { text: 'original' });
    const file = pluginDataPath(home, 'sample', { key: 'page' })!;
    for (const raw of ['', '{', '{"text":"truncated"']) {
      writeFileSync(file, raw);
      expect(() => data.documents.read('page')).toThrow('JSON 损坏');
      expect(() => data.documents.write('page', 'replacement')).toThrow('JSON 损坏');
      expect(() => data.documents.write('page', 'replacement', { expectedVersion: null })).toThrow('JSON 损坏');
      expect(readFileSync(file, 'utf8')).toBe(raw);
      expect(readdirSync(`${file}.lock.owners`)).toEqual([]);
      expect(readdirSync(dirname(file)).some((name) => name.endsWith('.tmp'))).toBe(false);
    }
    writeFileSync(file, 'null\n');
    const empty = data.documents.read('page');
    expect(empty.value).toBeNull();
    expect(typeof empty.version).toBe('string');
    expect(data.documents.write('page', 'restored', { expectedVersion: empty.version }).ok).toBe(true);
  });

  it('preserves broken-config semantics but reports real IO failures', () => {
    writePluginData(home, 'sample', 'original');
    const file = pluginDataPath(home, 'sample')!;
    writeFileSync(file, '{');
    const broken = readPluginData(home, 'sample');
    expect(broken.value).toBeNull();
    expect(typeof broken.version).toBe('string');
    expect(writePluginData(home, 'sample', 'restored', { expectedVersion: broken.version }).ok).toBe(true);
    mkdirSync(pluginDataPath(home, 'sample', { key: 'directory' })!, { recursive: true });
    expect(() => readPluginData(home, 'sample', { key: 'directory' })).toThrow('读取插件数据失败');
  });

  it('enforces JSON serialization and UTF-8 byte limits without overwriting data', () => {
    const data = createPluginDataApi(home, 'sample');
    data.write('original');
    expect(() => data.write('x'.repeat(PLUGIN_DATA_MAX_BYTES))).toThrow('256 KiB');
    expect(data.read().value).toBe('original');
    expect(data.documents.write('page', 'x'.repeat(PLUGIN_DATA_MAX_BYTES)).ok).toBe(true);
    expect(() => data.documents.write('page', 'x'.repeat(PLUGIN_DOCUMENT_MAX_BYTES))).toThrow('6 MiB');
    for (const [options, maxBytes] of [[{}, PLUGIN_DATA_MAX_BYTES], [{ key: 'page' }, PLUGIN_DOCUMENT_MAX_BYTES]] as const) {
      expect(encodePluginData('x'.repeat(maxBytes - 2), options).ok).toBe(true);
      expect(encodePluginData('x'.repeat(maxBytes - 1), options).ok).toBe(false);
      expect(encodePluginData('界'.repeat(Math.floor(maxBytes / 3)), options).ok).toBe(false);
    }
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const value of [undefined, 1n, circular]) expect(encodePluginData(value).ok).toBe(false);
    expect(decodePluginData('{')).toBeNull();
    expect(() => decodePluginData('{', { strict: true })).toThrow('JSON 损坏');
  });

  it('rejects unsafe ids and keys before creating files', () => {
    for (const id of ['', '../escape', 'a/b', 'a\\b', '..', null, 42]) {
      expect(pluginDataPath(home, id)).toBeNull();
      expect(() => writePluginData(home, id, {})).toThrow('非法');
    }
    for (const key of ['', '../escape', 'a..b', 'a/b', 'a\\b', '.hidden', 'a\n', 'a'.repeat(129), null, undefined, 42]) {
      expect(isValidPluginDocumentKey(key)).toBe(false);
      expect(() => readPluginData(home, 'sample', { key })).toThrow('key 非法');
      expect(() => writePluginData(home, 'sample', {}, { key })).toThrow('key 非法');
    }
    expect(pluginDataPath('', 'sample')).toBeNull();
    expect(readdirSync(home)).toEqual([]);
  });

  it('rejects symlinks in every document path component and the lock directory', () => {
    const elsewhere = join(home, 'elsewhere');
    mkdirSync(elsewhere);
    const source = join(elsewhere, 'original.json');
    writeFileSync(source, '"untouched"');
    const plugin = join(home, 'plugin-data', 'sample');
    const documents = join(plugin, 'documents');
    const file = pluginDataPath(home, 'sample', { key: 'page' })!;
    for (const path of [join(home, 'plugin-data'), plugin, documents, file, `${file}.lock.owners`]) {
      mkdirSync(dirname(path), { recursive: true });
      symlinkSync(path === file ? source : elsewhere, path);
      try {
        expect(() => readPluginData(home, 'sample', { key: 'page' })).toThrow('符号链接');
        expect(() => writePluginData(home, 'sample', 'replacement', { key: 'page' })).toThrow('符号链接');
        expect(readdirSync(elsewhere)).toEqual(['original.json']);
        expect(readFileSync(source, 'utf8')).toBe('"untouched"');
      } finally {
        rmSync(path);
      }
    }
  });
});

describe('PluginManager data capability', () => {
  function context(): PluginBaseContext {
    return {
      paths: { home, config: home, plugins: join(home, 'plugins') },
      hooks: new HookRegistry(),
      commands: new micaCommands.CommandRegistry(),
      services: new ServiceContainer(),
      events: new micaRuntime.RuntimeEventBus(),
    };
  }

  it('recognizes requires:data and binds separate plugin identities instead of host-injected data', async () => {
    const manager = new PluginManager();
    for (const id of ['first', 'second']) {
      const parsed = parsePluginManifest({ id, name: id, version: '1.0.0', requires: ['data'] });
      if (!parsed.ok) throw new Error(parsed.error);
      manager.register({ id, manifest: parsed.manifest, setup: (ctx) => { ctx.data!.write({ id }); } });
    }
    const host = { ...context(), data: createPluginDataApi(home, 'unrelated') };
    try {
      expect((await manager.setupAll(host)).loaded).toEqual(['first', 'second']);
      expect(readPluginData(home, 'first').value).toEqual({ id: 'first' });
      expect(readPluginData(home, 'second').value).toEqual({ id: 'second' });
      expect(readPluginData(home, 'unrelated').value).toBeNull();
    } finally {
      await manager.disposeAll();
    }
  });

  it('omits data without config paths and skips plugins requiring it', async () => {
    const manager = new PluginManager();
    const parsed = parsePluginManifest({ id: 'needs-data', name: 'Needs data', version: '1.0.0', requires: ['data'] });
    if (!parsed.ok) throw new Error(parsed.error);
    const setup = vi.fn();
    let observer: PluginContext | undefined;
    manager.register({ id: 'needs-data', manifest: parsed.manifest, setup });
    manager.register({ id: 'observer', setup: (ctx) => { observer = ctx; } });
    const host = context();
    delete host.paths;
    try {
      const report = await manager.setupAll({ ...host, data: createPluginDataApi(home, 'unrelated') } as PluginBaseContext);
      expect(report.skipped).toEqual([{ pluginId: 'needs-data', missing: ['data'] }]);
      expect(setup).not.toHaveBeenCalled();
      expect(observer).toBeDefined();
      expect(Object.hasOwn(observer!, 'data')).toBe(false);
    } finally {
      await manager.disposeAll();
    }
  });
});

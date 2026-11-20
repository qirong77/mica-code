import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectionsPeerStore } from './connections.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'mica-connections-migration-'));
  homes.push(home);
  const directory = join(home, 'plugin-data', 'connections');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'data.json');
  const log = vi.fn();
  return { home, file, log, run: () => connectionsPeerStore.run({ home, log }) };
}

function archived(home: string): string {
  const directory = join(home, 'plugin-data', 'evolution', 'legacy-connections');
  const [name] = readdirSync(directory);
  return readFileSync(join(directory, name!), 'utf8');
}

describe('Connections 数据迁移', () => {
  it.each([
    ['纯地址数组', ['10.0.0.1', 'http://10.0.0.2:9102', '10.0.0.1']],
    ['缺 version 的对象', { peers: [{ url: '10.0.0.1' }, { url: 'http://10.0.0.2:9102' }] }],
  ])('把 %s 迁为当前形态，归档原文且可重复执行', (_label, legacy) => {
    const { home, file, run } = setup();
    const original = JSON.stringify(legacy, null, 2);
    writeFileSync(file, original);

    expect(run()).toBe(1);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      version: 1,
      peers: [
        { url: 'http://10.0.0.1:8787', note: '' },
        { url: 'http://10.0.0.2:9102', note: '' },
      ],
    });
    expect(archived(home)).toBe(original);
    expect(run()).toBe(0);
  });

  it('对当前对象、损坏内容和未知形态不覆盖', () => {
    const current = setup();
    const currentText = JSON.stringify({ version: 1, peers: [{ url: '10.0.0.1' }] });
    writeFileSync(current.file, currentText);
    expect(current.run()).toBe(0);
    expect(readFileSync(current.file, 'utf8')).toBe(currentText);

    const broken = setup();
    writeFileSync(broken.file, '{broken');
    expect(broken.run()).toBe(0);
    expect(readFileSync(broken.file, 'utf8')).toBe('{broken');

    const unknown = setup();
    const unknownText = JSON.stringify({ version: 2, peers: [] });
    writeFileSync(unknown.file, unknownText);
    expect(unknown.run()).toBe(0);
    expect(readFileSync(unknown.file, 'utf8')).toBe(unknownText);
  });

  it('不跟随 data.json 符号链接，也不覆盖链接目标', () => {
    const { home, file, run } = setup();
    const outside = join(home, 'outside.json');
    writeFileSync(outside, JSON.stringify(['10.0.0.9']));
    rmSync(file, { force: true });
    symlinkSync(outside, file);
    expect(run()).toBe(0);
    expect(readFileSync(outside, 'utf8')).toBe(JSON.stringify(['10.0.0.9']));
    expect(existsSync(join(home, 'plugin-data', 'evolution', 'legacy-connections'))).toBe(false);
  });
});

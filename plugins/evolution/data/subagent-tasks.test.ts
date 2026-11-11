import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { subagentTaskFiles } from './subagent-tasks.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'mica-task-migration-'));
  homes.push(home);
  const root = join(home, 'subagent-tasks');
  mkdirSync(root);
  const context = { home, log: vi.fn() };
  return { root, context, run: () => subagentTaskFiles.run(context) };
}

function task(id: string, status = 'completed') {
  return {
    id,
    description: id,
    subagent_type: 'Implementer',
    model: 'm',
    effort: 'low',
    status,
    started_at: '2026-01-01T00:00:00Z',
    result: '保留完整结果',
    usage: { totalTokens: 17 },
  };
}

it('splits legacy arrays without changing task payloads, archives the source, and is idempotent', () => {
  const { root, run } = setup();
  const records = [task('one', 'running'), task('two'), task('one')];
  const source = JSON.stringify(records, null, 2);
  writeFileSync(join(root, 'session.json'), source);
  expect(run()).toBe(1);
  expect(JSON.parse(readFileSync(join(root, 'session', 'one.json'), 'utf8'))).toEqual(records[2]);
  expect(JSON.parse(readFileSync(join(root, 'session', 'two.json'), 'utf8'))).toEqual(records[1]);
  expect(readFileSync(join(root, 'session.legacy-v1.json'), 'utf8')).toBe(source);
  expect(existsSync(join(root, 'session.json'))).toBe(false);
  expect(run()).toBe(0);
  expect(readdirSync(join(root, 'session')).sort()).toEqual(['one.json', 'two.json']);
});

it('retains existing per-task updates and old archives when resuming a partial migration', () => {
  const { root, run } = setup();
  writeFileSync(join(root, 'session.json'), JSON.stringify([task('one', 'running'), task('two')]));
  mkdirSync(join(root, 'session'));
  const current = JSON.stringify({ ...task('one'), result: '更新后的结果' });
  writeFileSync(join(root, 'session', 'one.json'), current);
  writeFileSync(join(root, 'session.legacy-v1.json'), 'previous archive');
  expect(run()).toBe(1);
  expect(readFileSync(join(root, 'session', 'one.json'), 'utf8')).toBe(current);
  expect(readFileSync(join(root, 'session.legacy-v1.json'), 'utf8')).toBe('previous archive');
  expect(existsSync(join(root, 'session.legacy-v1.1.json'))).toBe(true);
});

it.each(['{', JSON.stringify([task('valid'), { ...task('../escape') }]), JSON.stringify({ tasks: [] })])(
  'keeps malformed or unknown source data intact: %s',
  (source) => {
    const { root, context, run } = setup();
    writeFileSync(join(root, 'session.json'), source);
    expect(run()).toBe(0);
    expect(readFileSync(join(root, 'session.json'), 'utf8')).toBe(source);
    expect(readdirSync(root)).toEqual(['session.json']);
    expect(context.log).toHaveBeenCalledWith('evolution:subagent-tasks-failed', expect.anything());
  },
);

it('does not replace malformed current records or follow a symlinked task directory', () => {
  const { root, run } = setup();
  writeFileSync(join(root, 'session.json'), JSON.stringify([task('one')]));
  mkdirSync(join(root, 'session'));
  writeFileSync(join(root, 'session', 'one.json'), '{');
  expect(run()).toBe(0);
  expect(readFileSync(join(root, 'session', 'one.json'), 'utf8')).toBe('{');
  expect(existsSync(join(root, 'session.json'))).toBe(true);

  writeFileSync(join(root, 'linked.json'), JSON.stringify([task('one')]));
  symlinkSync(join(root, 'session'), join(root, 'linked'));
  expect(run()).toBe(0);
  expect(existsSync(join(root, 'linked.json'))).toBe(true);
});

it('archives empty arrays and leaves unrelated files and symlinked sources alone', () => {
  const { root, run } = setup();
  writeFileSync(join(root, 'empty.json'), '[]');
  writeFileSync(join(root, 'notes.txt'), 'notes');
  symlinkSync(join(root, 'empty.json'), join(root, 'linked.json'));
  expect(run()).toBe(1);
  expect(readFileSync(join(root, 'empty.legacy-v1.json'), 'utf8')).toBe('[]');
  expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('notes');
  expect(readdirSync(root)).toContain('linked.json');
  expect(run()).toBe(0);
});

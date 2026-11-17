import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Explicit opt-in path keeps normal isolated test runs away from personal plugins.
const home = process.env.MICA_USER_PLUGIN_FIXTURES || join(homedir(), '.mica', 'plugins');
function diffSetup() {
  // Evaluate only the entry with mocked imports; no user-plugin dependency is executed.
  const source = readFileSync(`${home}/git-diff-context/index.js`, 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace('export default function setup', 'function setup');
  const branch = vi.fn(() => 'test');
  const diff = vi.fn(() => ({ diff: '', emptyMessage: () => 'empty', label: 'master' }));
  const setup = vm.runInNewContext(`${source}\nsetup`, {
    Error,
    getCurrentBranch: branch,
    loadDiffContext: diff,
    buildMessage: () => 'message',
    buildDisplayMessage: () => 'display',
  });
  let handler: (ctx: unknown, args: string) => Promise<any>;
  const ctx = {
    commands: {
      register: (command: any) => {
        handler = command.handler;
        return { dispose() {} };
      },
    },
    onDispose() {},
    logger: { info() {}, error() {} },
    ui: { submit: vi.fn(), showMessage: vi.fn() },
  };
  setup(ctx);
  return { execute: () => handler(null, ''), branch, diff, ctx };
}
describe.skipIf(!existsSync(`${home}/git-diff-context/index.js`) || !existsSync(`${home}/demand-dev/scripts/osim.mjs`))(
  'authorized user plugin fixes (source evaluated with mocks only)',
  () => {
    it('treats empty diffs as success and exceptions as failure', async () => {
      const { execute, branch, ctx } = diffSetup();
      expect(await execute()).toMatchObject({ ok: true, code: 'empty_diff' });
      expect(ctx.ui.submit).not.toHaveBeenCalled();
      branch.mockImplementationOnce(() => {
        throw new Error('mock git error');
      });
      expect(await execute()).toMatchObject({
        ok: false,
        outcome: 'error',
        code: 'git_diff_failed',
        error: 'mock git error',
      });
    });
    it('reports submission failure rather than unconditional success', async () => {
      const { execute, diff, ctx } = diffSetup();
      diff.mockReturnValue({ diff: 'x', emptyMessage: () => 'empty', label: 'master' });
      ctx.ui.submit.mockRejectedValue(new Error('submit failed'));
      expect(await execute()).toMatchObject({ ok: false, code: 'git_diff_failed' });
    });
    it('validates wait timing before project/git/API resolution', async () => {
      const source = readFileSync(`${home}/demand-dev/scripts/osim.mjs`, 'utf8');
      const start = source.indexOf('function positiveWaitSeconds(');
      const end = source.indexOf('// ---------- stamp ----------', start);
      const forbidden = vi.fn(() => {
        throw new Error('must not access project or external services');
      });
      const { positiveWaitSeconds, commandWait } = vm.runInNewContext(
        `${source.slice(start, end)}\n({ positiveWaitSeconds, commandWait })`,
        { resolveProjects: forbidden, detectProject: forbidden },
      );
      for (const key of ['--timeout', '--interval']) {
        for (const value of ['0', '-1', 'NaN', 'Infinity', '', true, '1e100', '0.000001']) {
          await expect(commandWait({}, { flags: { _: [] }, options: new Map([[key, value]]) })).rejects.toThrow(
            '必须是正有限秒数',
          );
        }
      }
      expect(forbidden).not.toHaveBeenCalled();
      expect(positiveWaitSeconds(new Map(), '--interval', 20)).toBe(20);
      expect(positiveWaitSeconds(new Map([['--interval', '1.5']]), '--interval', 20)).toBe(1.5);
    });
  },
);

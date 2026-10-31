import { describe, expect, it, vi, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({ sync: vi.fn(), async: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: mocks.sync, execFile: mocks.async }));
const { hasUnmergedFiles, parsePorcelainStatus, pushCurrentBranch } = await import('./git.js');
afterEach(() => vi.resetAllMocks());

describe('git porcelain paths', () => {
  it('keeps NUL-delimited paths verbatim and skips rename source records', () => {
    const status = 'R  中文 -> new.txt\0UU old\nname.txt\0?? file with spaces \0';
    expect(parsePorcelainStatus(status)).toEqual([
      { status: 'R ', path: '中文 -> new.txt' },
      { status: '??', path: 'file with spaces ' },
    ]);
    expect(hasUnmergedFiles(status)).toBe(false);
    expect(hasUnmergedFiles(`${status}UU conflict.txt\0`)).toBe(true);
  });
});

describe('pushCurrentBranch', () => {
  it('sets upstream when pushing an existing same-name remote branch', async () => {
    mocks.sync.mockImplementation((_file, args: string[]) => {
      if (args.includes('@{u}')) throw new Error('no upstream');
      if (args.includes('get-url')) return 'mock-origin';
      return 'feature\n';
    });
    mocks.async.mockImplementation((_file, args: string[], _options, callback) =>
      callback(null, { stdout: args[0] === 'ls-remote' ? 'abc refs/heads/feature\n' : '', stderr: '' }),
    );
    expect(await pushCurrentBranch('/mock-repo')).toBe(true);
    expect(mocks.async.mock.calls.map((call) => call[1])).toEqual([
      ['ls-remote', '--heads', 'origin', 'feature'],
      ['push', '--set-upstream', 'origin', 'feature'],
    ]);
  });

  it('reports remote lookup failures instead of saying there is no remote branch', async () => {
    mocks.sync.mockImplementation((_file, args: string[]) => {
      if (args.includes('@{u}')) throw new Error('no upstream');
      return 'feature\n';
    });
    mocks.async.mockImplementation((_file, _args, _options, callback) =>
      callback(new Error('mock lookup failed'), '', ''),
    );
    await expect(pushCurrentBranch('/mock-repo')).rejects.toThrow('mock lookup failed');
  });
});

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const compiler = spawnSync('clang', ['--version'], { encoding: 'utf8' });
// 编译真实 helper 的组合键解析，事件出口换成计数器；不链接或调用桌面 API。
describe.skipIf(compiler.status !== 0)('native chord validation', () => {
  let dir: string;
  let binary: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mica-chord-'));
    binary = join(dir, 'chord');
    const source = readFileSync(new URL('./runtime/src/helper.m', import.meta.url), 'utf8');
    const keys = source.slice(
      source.indexOf('typedef struct {\n    const char *name;'),
      source.indexOf('static void postKey('),
    );
    const command = source.slice(source.indexOf('static int cmdChord('), source.indexOf('// MARK: - 权限自检'));
    const testSource = `
      #include <stdio.h>
      #include <string.h>
      #include <ctype.h>
      #include <stdarg.h>
      typedef unsigned short CGKeyCode;
      typedef unsigned long long CGEventFlags;
      enum { kCGEventFlagMaskCommand = 1, kCGEventFlagMaskShift = 2,
        kCGEventFlagMaskAlternate = 4, kCGEventFlagMaskControl = 8, kCGEventFlagMaskAlphaShift = 16 };
      static int failJson(const char *format, ...) {
        va_list args; va_start(args, format); vfprintf(stderr, format, args); va_end(args); return 1;
      }
      static void postFlags(CGKeyCode code, CGEventFlags flags) { printf("flag:%llu\\n", flags); }
      static void postKey(CGKeyCode code, int down, CGEventFlags flags) { printf("key:%d:%llu\\n", down, flags); }
      #define usleep(ms) ((void)0)
      ${keys}
      ${command}
      int main(int argc, char **argv) { return cmdChord(argv[1]); }
    `;
    const input = join(dir, 'chord.c');
    writeFileSync(input, testSource);
    const result = spawnSync('clang', [input, '-o', binary], { encoding: 'utf8', timeout: 20_000 });
    expect(result.status, result.stderr).toBe(0);
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.each(['cmd+a+b', 'cmd+shift+a+b', 'cmd+shift+alt+ctrl+cmd+shift+alt+ctrl+a', 'cmd++a', 'cmd+', '+a', 'cmd+ +a'])(
    'rejects %s before pressing any keys',
    (chord) => {
      const result = spawnSync(binary, [chord], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/不是修饰键|最多支持|空/);
    },
  );

  it('presses and releases the modifiers for a valid shortcut', () => {
    const result = spawnSync(binary, ['cmd+shift+a'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      'flag:1',
      'flag:3',
      'key:1:3',
      'key:0:3',
      'flag:1',
      'flag:0',
      '{"ok":true,"chord":"cmd+shift+a"}',
    ]);
  });
});

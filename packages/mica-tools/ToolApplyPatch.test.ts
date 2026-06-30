import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolApplyPatch } from './ToolApplyPatch.js';
import { getToolDefinitions } from './registry.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mica-apply-patch-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function pathInTemp(name: string): string {
  return join(tempDir, name);
}

describe('ToolApplyPatch', () => {
  it('is registered as a builtin tool', () => {
    expect(getToolDefinitions().some((tool) => tool.name === 'apply_patch')).toBe(true);
  });

  it('shows a concise single-file patch display text', () => {
    const tool = new ToolApplyPatch();
    const filePath = pathInTemp('update.txt');

    expect(
      tool.onToolUseDisplayText({
        patch: `*** Begin Patch
*** Update File: ${filePath}
@@
-old
+new
*** End Patch
`,
      }),
    ).toBe('Patch update.txt · +1/-1');
  });

  it('shows operation details for structural patch display text', () => {
    const tool = new ToolApplyPatch();
    const addPath = pathInTemp('added.txt');
    const deletePath = pathInTemp('deleted.txt');

    expect(
      tool.onToolUseDisplayText({
        patch: `*** Begin Patch
*** Add File: ${addPath}
+hello
+world
*** Delete File: ${deletePath}
*** End Patch
`,
      }),
    ).toBe('Patch added.txt +1 more · 1 add, 1 delete · +2');
  });

  it('shows file names for move patch display text', () => {
    const tool = new ToolApplyPatch();
    const oldPath = pathInTemp('old.txt');
    const newPath = pathInTemp('new.txt');

    expect(
      tool.onToolUseDisplayText({
        patch: `*** Begin Patch
*** Update File: ${oldPath}
*** Move to: ${newPath}
@@
-name=old
+name=new
*** End Patch
`,
      }),
    ).toBe('Patch old.txt -> new.txt · 1 move · +1/-1');
  });

  it('adds a new file', async () => {
    const tool = new ToolApplyPatch();
    const filePath = pathInTemp('new-file.txt');

    const result = await tool.execute({
      patch: `*** Begin Patch
*** Add File: ${filePath}
+hello
+world
*** End Patch
`,
    });

    expect(result).toContain('apply_patch 成功');
    expect(result).toContain(`- add ${filePath}`);
    expect(readFileSync(filePath, 'utf-8')).toBe('hello\nworld\n');
  });

  it('updates an existing file with context', async () => {
    const tool = new ToolApplyPatch();
    const filePath = pathInTemp('update.txt');
    writeFileSync(filePath, 'alpha\nbeta\ngamma\n');

    const result = await tool.execute({
      patch: `*** Begin Patch
*** Update File: ${filePath}
@@
 alpha
-beta
+bravo
 gamma
*** End Patch
`,
    });

    expect(result).toContain(`- update ${filePath}`);
    expect(readFileSync(filePath, 'utf-8')).toBe('alpha\nbravo\ngamma\n');
  });

  it('deletes an existing file', async () => {
    const tool = new ToolApplyPatch();
    const filePath = pathInTemp('delete.txt');
    writeFileSync(filePath, 'remove me\n');

    const result = await tool.execute({
      patch: `*** Begin Patch
*** Delete File: ${filePath}
*** End Patch
`,
    });

    expect(result).toContain(`- delete ${filePath}`);
    expect(existsSync(filePath)).toBe(false);
  });

  it('moves and updates a file', async () => {
    const tool = new ToolApplyPatch();
    const oldPath = pathInTemp('old.txt');
    const newPath = pathInTemp('nested/new.txt');
    writeFileSync(oldPath, 'name=old\n');

    const result = await tool.execute({
      patch: `*** Begin Patch
*** Update File: ${oldPath}
*** Move to: ${newPath}
@@
-name=old
+name=new
*** End Patch
`,
    });

    expect(result).toContain(`- move ${oldPath} -> ${newPath}`);
    expect(existsSync(oldPath)).toBe(false);
    expect(readFileSync(newPath, 'utf-8')).toBe('name=new\n');
  });

  it('rejects moves over existing files without modifying either file', async () => {
    const tool = new ToolApplyPatch();
    const oldPath = pathInTemp('move-source.txt');
    const newPath = pathInTemp('move-target.txt');
    writeFileSync(oldPath, 'source\n');
    writeFileSync(newPath, 'target\n');

    await expect(
      tool.execute({
        patch: `*** Begin Patch
*** Update File: ${oldPath}
*** Move to: ${newPath}
@@
-source
+updated
*** End Patch
`,
      }),
    ).rejects.toThrow('已存在');

    expect(readFileSync(oldPath, 'utf-8')).toBe('source\n');
    expect(readFileSync(newPath, 'utf-8')).toBe('target\n');
  });

  it('rejects ambiguous hunks without modifying the file', async () => {
    const tool = new ToolApplyPatch();
    const filePath = pathInTemp('ambiguous.txt');
    writeFileSync(filePath, 'same\nsame\n');

    await expect(
      tool.execute({
        patch: `*** Begin Patch
*** Update File: ${filePath}
@@
-same
+changed
*** End Patch
`,
      }),
    ).rejects.toThrow('匹配不唯一');

    expect(readFileSync(filePath, 'utf-8')).toBe('same\nsame\n');
  });

  it('rejects invalid patches without applying earlier operations', async () => {
    const tool = new ToolApplyPatch();
    const addPath = pathInTemp('added.txt');
    const missingPath = pathInTemp('missing.txt');

    await expect(
      tool.execute({
        patch: `*** Begin Patch
*** Add File: ${addPath}
+created
*** Delete File: ${missingPath}
*** End Patch
`,
      }),
    ).rejects.toThrow('不存在');

    expect(existsSync(addPath)).toBe(false);
  });
});

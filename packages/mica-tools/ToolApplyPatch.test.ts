import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolApplyPatch } from './ToolApplyPatch.js';

/**
 * 这些用例守的是**报错文本**：apply_patch 的最高频失败是模型写出「只有上下文行」的补丁、
 * 或压根没写首行标记，然后靠猜重试。错误文本因此必须给出可照抄的最小形态与下一步动作，
 * 否则修掉一个错会原地长出下一个。
 */
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mica-apply-patch-hints-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function pathInTemp(name: string): string {
  return join(tempDir, name);
}

async function failureMessage(patch: string): Promise<string> {
  try {
    await new ToolApplyPatch().execute({ patch });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('预期 apply_patch 失败，但它成功了');
}

describe('ToolApplyPatch 报错里的自引用指引', () => {
  it('helps with a hunk that only carries context lines', async () => {
    const filePath = pathInTemp('context-only.txt');
    writeFileSync(filePath, 'alpha\nbeta\n');

    const message = await failureMessage(
      ['*** Begin Patch', `*** Update File: ${filePath}`, '@@', ' alpha', ' beta', '*** End Patch', ''].join('\n'),
    );

    // 整份 patch 都是上下文：确实没改任何东西，必须报错而不是静默成功。
    expect(message).toContain('只有上下文行，没有任何 + / - 改动');
    expect(message).toContain('什么都没写');
    // 可直接照抄的最小形态：首尾标记 + Update File + @@ + 一行 - 和一行 +
    expect(message).toContain('*** Begin Patch');
    expect(message).toContain('*** Update File: 路径');
    expect(message).toContain('@@');
    expect(message).toContain('-旧内容');
    expect(message).toContain('+新内容');
    expect(message).toContain('*** End Patch');
    expect(readFileSync(filePath, 'utf-8')).toBe('alpha\nbeta\n');
  });

  // 真实数据里最常见的失败形态：模型把上下文 hunk 当锚点写在真正改动旁边，
  // 旧实现因为那一块把整份 patch 拒了，本来正确的改动白丢一次往返。
  it('skips a context-only hunk when the patch has a real change and says so', async () => {
    const filePath = pathInTemp('mixed-hunks.txt');
    writeFileSync(filePath, 'one\ntwo\nthree\nfour\n');

    const result = await new ToolApplyPatch().execute({
      patch: [
        '*** Begin Patch',
        `*** Update File: ${filePath}`,
        '@@',
        ' two',
        '-three',
        '+THREE',
        '@@',
        ' one',
        '*** End Patch',
        '',
      ].join('\n'),
    });

    expect(readFileSync(filePath, 'utf-8')).toBe('one\ntwo\nTHREE\nfour\n');
    // 跳过不等于没发生：模型必须知道那一块没生效。
    expect(result).toContain('已跳过');
    expect(result).toContain('第 7 行');
  });

  it('helps with a patch missing the begin marker', async () => {
    const filePath = pathInTemp('no-header.txt');
    writeFileSync(filePath, 'alpha\n');

    const message = await failureMessage(
      [`*** Update File: ${filePath}`, '@@', '-alpha', '+beta', '*** End Patch', ''].join('\n'),
    );

    expect(message).toContain('必须以 *** Begin Patch 开始');
    expect(message).toContain('第 1 行是');
    expect(message).toContain('-旧内容');
    expect(message).toContain('+新内容');
    expect(message).toContain('下一步');
  });

  it('explains why a hunk fails to match, and how to narrow it', async () => {
    const filePath = pathInTemp('mismatch.txt');
    writeFileSync(filePath, 'alpha\nbeta\n');

    const message = await failureMessage(
      ['*** Begin Patch', `*** Update File: ${filePath}`, '@@', '-gamma', '+delta', '*** End Patch', ''].join('\n'),
    );

    expect(message).toContain('找不到 hunk 对应内容');
    expect(message).toContain('缩进');
    expect(message).toContain('read_file');
    expect(message).toContain('上下文行越少越不容易错');
    // 分类器（harness-review）按文本区分「补丁头缺失」，这里不能出现补丁首行标记
    expect(message).not.toContain('*** Begin Patch');
    expect(readFileSync(filePath, 'utf-8')).toBe('alpha\nbeta\n');
  });

  it('still applies a correct patch', async () => {
    const filePath = pathInTemp('ok.txt');
    writeFileSync(filePath, 'alpha\nbeta\ngamma\n');

    const result = await new ToolApplyPatch().execute({
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

    expect(result).toContain('apply_patch 成功');
    expect(readFileSync(filePath, 'utf-8')).toBe('alpha\nbravo\ngamma\n');
  });
});

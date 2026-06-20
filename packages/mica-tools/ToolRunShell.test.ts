import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolRunShell } from './ToolRunShell.js';

function bunEval(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

function parseOutputPath(result: string): string {
  const match = result.match(/^输出文件: (.+)$/m);
  expect(match).not.toBeNull();
  return match![1]!.trim();
}

async function waitForFileContains(filePath: string, text: string): Promise<string> {
  const deadline = Date.now() + 2000;
  let content = '';
  while (Date.now() < deadline) {
    try {
      content = readFileSync(filePath, 'utf-8');
      if (content.includes(text)) return content;
    } catch {
      // The background process may not have flushed output yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return content;
}

describe('ToolRunShell', () => {
  it('returns structured metadata and separates stdout from stderr', async () => {
    const tool = new ToolRunShell();

    const result = await tool.execute({
      command: bunEval("console.log('stdout-line'); console.error('stderr-line')"),
    });

    expect(result).toContain('[command]');
    expect(result).toContain('exit_code: 0');
    expect(result).toContain('[stdout]\nstdout-line');
    expect(result).toContain('[stderr]\nstderr-line');
  });

  it('runs commands in the requested cwd', async () => {
    const tool = new ToolRunShell();
    const cwd = path.resolve(process.cwd(), 'packages/mica-tools');

    const result = await tool.execute({
      command: bunEval('console.log(process.cwd())'),
      cwd: 'packages/mica-tools',
    });

    expect(result).toContain(`cwd: ${cwd}`);
    expect(result).toContain(`[stdout]\n${cwd}`);
  });

  it('clamps timeout metadata to the supported range', async () => {
    const tool = new ToolRunShell();

    const result = await tool.execute({
      command: bunEval("console.log('ok')"),
      timeout: -10,
    });

    expect(result).toContain('timeout_ms: 250');
  });

  it('reports stream cap and preserves tail output', async () => {
    const tool = new ToolRunShell();

    const result = await tool.execute({
      command: bunEval("process.stdout.write('A'.repeat(125000)); process.stdout.write('TAIL')"),
    });

    expect(result).toContain('stream_output_truncated: true');
    expect(result).toContain('stdout_truncated: true');
    expect(result).toContain('TAIL');
  });

  it('starts background commands with pid/cwd metadata and an output file header', async () => {
    const tool = new ToolRunShell();
    const cwd = process.cwd();

    const result = await tool.execute({
      command: bunEval("console.log('background ok')"),
      run_in_background: true,
    });
    const outputPath = parseOutputPath(result);

    try {
      expect(result).toContain('pid: ');
      expect(result).toContain(`cwd: ${cwd}`);
      expect(result).toContain('输出上限: 64.0MB');

      const content = await waitForFileContains(outputPath, 'background ok');
      expect(content).toContain('[mica background task]');
      expect(content).toContain(`cwd: ${cwd}`);
      expect(content).toContain('[mica background task spawned]');
      expect(content).toContain('background ok');
    } finally {
      rmSync(outputPath, { force: true });
    }
  });
});

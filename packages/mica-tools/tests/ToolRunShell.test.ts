import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolRunShell } from '../ToolRunShell.js';
import { getBackgroundTaskDir, listBackgroundTasks, waitForBackgroundSpawn } from '../ToolRunShellBackground.js';
import { ToolBackgroundTasks } from '../ToolBackgroundTasks.js';
import { ToolReadTaskOutput } from '../ToolReadTaskOutput.js';
import { ToolKillTask } from '../ToolKillTask.js';

function bunEval(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

function parseOutputPath(result: string): string {
  const match = result.match(/^输出文件: (.+)$/m);
  expect(match).not.toBeNull();
  return match![1]!.trim();
}

function parseTaskId(result: string): string {
  const match = result.match(/id: ([a-f0-9]{12})/);
  expect(match).not.toBeNull();
  return match![1]!;
}

function cleanupTask(outputPath: string): void {
  const taskDir = dirname(outputPath);
  const id = path.basename(outputPath, '.out');
  rmSync(outputPath, { force: true });
  rmSync(path.join(taskDir, `${id}.json`), { force: true });
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

  it('allows cwd outside the workspace', async () => {
    const tool = new ToolRunShell();
    const cwd = realpathSync(tmpdir());

    const result = await tool.execute({
      command: bunEval('console.log(process.cwd())'),
      cwd,
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
    const readTaskOutput = new ToolReadTaskOutput();
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

      const taskId = parseTaskId(result);
      expect(result).toContain(`查看输出: read_task_output(task_id="${taskId}")`);
      expect(result).toContain(`终止任务: kill_task(task_id="${taskId}")`);

      const content = await waitForFileContains(outputPath, '[mica background task exited]');
      expect(content).toContain('[mica background task]');
      expect(content).toContain(`cwd: ${cwd}`);
      expect(content).toContain('[mica background task spawned]');
      expect(content).toContain('background ok');
      expect(content).toContain('[mica background task exited]');

      const outputResult = await readTaskOutput.execute({ task_id: taskId });
      expect(outputResult).toContain('status: finished');
    } finally {
      cleanupTask(outputPath);
    }
  });

  it('removes transient spawn listeners after background startup settles', async () => {
    const child = new EventEmitter();
    const resultPromise = waitForBackgroundSpawn(child as Parameters<typeof waitForBackgroundSpawn>[0]);

    child.emit('spawn');

    await expect(resultPromise).resolves.toEqual({ ok: true });
    expect(child.listenerCount('spawn')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
  });

  it('does not list background tasks from another mica process directory', () => {
    const oldTaskDir = path.join(tmpdir(), 'mica-tasks');
    const oldTaskId = 'abcdef123456';
    const oldOutputPath = path.join(oldTaskDir, `${oldTaskId}.out`);
    mkdirSync(oldTaskDir, { recursive: true });
    writeFileSync(oldOutputPath, 'old output', 'utf-8');
    writeFileSync(
      path.join(oldTaskDir, `${oldTaskId}.json`),
      JSON.stringify({
        id: oldTaskId,
        command: 'old command',
        cwd: process.cwd(),
        shell: '/bin/sh',
        output_path: oldOutputPath,
        status: 'killed',
        started_at: new Date().toISOString(),
        output_limit_bytes: 1024,
      }),
      'utf-8',
    );

    try {
      expect(getBackgroundTaskDir()).not.toBe(oldTaskDir);
      expect(listBackgroundTasks({ status: 'all' }).some((task) => task.id === oldTaskId)).toBe(false);
    } finally {
      rmSync(oldOutputPath, { force: true });
      rmSync(path.join(oldTaskDir, `${oldTaskId}.json`), { force: true });
    }
  });

  it('lists, reads, and kills background tasks by id', async () => {
    const runShell = new ToolRunShell();
    const listTasks = new ToolBackgroundTasks();
    const readTaskOutput = new ToolReadTaskOutput();
    const killTask = new ToolKillTask();

    const result = await runShell.execute({
      command: bunEval("console.log('ready'); setInterval(() => console.log('tick'), 200)"),
      run_in_background: true,
    });
    const outputPath = parseOutputPath(result);
    const taskId = parseTaskId(result);

    try {
      await waitForFileContains(outputPath, 'ready');

      const listResult = await listTasks.execute({ status: 'running' });
      expect(listResult).toContain(taskId);
      expect(listResult).toContain('running');

      const outputResult = await readTaskOutput.execute({ task_id: taskId });
      expect(outputResult).toContain(`Task ${taskId}`);
      expect(outputResult).toContain('ready');

      const killResult = await killTask.execute({ task_id: taskId, force_after_ms: 100 });
      expect(killResult).toContain(`id: ${taskId}`);
      expect(killResult).toContain(`output: ${outputPath}`);
    } finally {
      cleanupTask(outputPath);
    }
  });
});

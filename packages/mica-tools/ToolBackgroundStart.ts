import { spawn } from 'child_process';
import { appendFileSync, closeSync, openSync, writeFileSync } from 'fs';
import { MicaTool } from './MicaTool.js';
import type { ToolExecuteCallbacks } from './MicaTool.js';
import { truncateDisplayText } from './utils/display.js';
import { formatSize } from './utils/outputLimits.js';
import {
  backgroundHeader,
  createBackgroundTaskMeta,
  ensureBackgroundTaskMonitor,
  getTaskOutputPath,
  markBackgroundTaskRunning,
  markBackgroundTaskSpawnFailed,
  MAX_BACKGROUND_OUTPUT_BYTES,
  taskId,
  waitForBackgroundSpawn,
} from './ToolRunShellBackground.js';
import { assertShellPathAccess } from './utils/pathOwnership.js';
import { defaultShell, readAgentTaskOwnerId, resolveCwd } from './utils/shell.js';

const DESCRIPTION = [
  '在后台启动一条 shell 命令，立刻返回 task_id，不等待它结束。',
  '',
  '用于：dev server、watch 模式、几分钟以上的构建/测试等不该占住当前回合的命令。启动之后可以继续做别的事，需要结果时：',
  '- `background_tasks_read(task_id)` 看当前输出与状态；',
  '- `background_tasks_list()` 不知道 id 时先列一遍；',
  '- `wait_for(kind="task", task_id)` 等到它结束再往下走（可与同一条消息里的其他调用并发执行）。',
  '不要用于：几秒就结束的命令，直接用 `run_shell` 更省事。',
].join('\n');

type BackgroundStartInput = {
  command: string;
  cwd?: string;
};

// The detached shell writes its own completion marker so the parent can drop ChildProcess listeners after spawn.
function backgroundCommand(command: string, id: string): string {
  if (process.platform === 'win32') return command;
  return [
    `__mica_task_id=${id}`,
    '__mica_status=0',
    '__mica_signal=null',
    '__mica_finish() {',
    '  __mica_status=$?',
    '  trap - EXIT INT TERM HUP',
    '  printf "\\n[mica background task exited]\\nid: %s\\nfinished_at: %s\\nexit_code: %s\\nsignal: %s\\n\\n" "$__mica_task_id" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$__mica_status" "$__mica_signal"',
    '  exit "$__mica_status"',
    '}',
    'trap __mica_finish EXIT',
    'trap "__mica_signal=SIGINT; exit 130" INT',
    'trap "__mica_signal=SIGTERM; exit 143" TERM',
    'trap "__mica_signal=SIGHUP; exit 129" HUP',
    command,
  ].join('\n');
}

export class ToolBackgroundStart extends MicaTool {
  constructor() {
    super(
      'background_tasks_start',
      DESCRIPTION,
      {
        type: 'object' as const,
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          cwd: {
            type: 'string',
            description: '命令工作目录。默认当前进程目录；相对路径会基于当前进程目录解析。',
          },
        },
        required: ['command'],
      },
      { readOnly: false },
    );
  }

  async execute(input: BackgroundStartInput, callbacks?: ToolExecuteCallbacks): Promise<string> {
    try {
      assertShellPathAccess(input.cwd, callbacks?.context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `工具 background_tasks_start 输入校验失败：${message}`;
    }
    const cwdResult = resolveCwd(input.cwd);
    if (!cwdResult.ok) return `工具 background_tasks_start 输入校验失败：${cwdResult.message}`;

    const id = taskId();
    const outputPath = getTaskOutputPath(id);
    const shell = defaultShell();

    createBackgroundTaskMeta({
      id,
      command: input.command,
      cwd: cwdResult.cwd,
      shell,
      outputPath,
      outputLimit: MAX_BACKGROUND_OUTPUT_BYTES,
      agentOwnerId: readAgentTaskOwnerId(callbacks?.context),
    });

    writeFileSync(
      outputPath,
      backgroundHeader({
        id,
        command: input.command,
        cwd: cwdResult.cwd,
        shell,
        pid: undefined,
        outputLimit: MAX_BACKGROUND_OUTPUT_BYTES,
      }),
      'utf-8',
    );
    const fd = openSync(outputPath, 'a');
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(backgroundCommand(input.command, id), {
        cwd: cwdResult.cwd,
        shell,
        detached: true,
        stdio: ['ignore', fd, fd],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markBackgroundTaskSpawnFailed(id, message);
      appendFileSync(outputPath, `\n[mica background task error]\nmessage: ${message}\n`, 'utf-8');
      return [`命令后台启动失败 (id: ${id})`, `cwd: ${cwdResult.cwd}`, `错误: ${message}`].join('\n');
    } finally {
      closeSync(fd);
    }

    const spawnResult = await waitForBackgroundSpawn(child);
    if (!spawnResult.ok) {
      markBackgroundTaskSpawnFailed(id, spawnResult.message);
      appendFileSync(outputPath, `\n[mica background task error]\nmessage: ${spawnResult.message}\n`, 'utf-8');
      return [`命令后台启动失败 (id: ${id})`, `cwd: ${cwdResult.cwd}`, `错误: ${spawnResult.message}`].join('\n');
    }

    markBackgroundTaskRunning(id, child.pid);
    appendFileSync(outputPath, `[mica background task spawned]\npid: ${child.pid ?? 'unknown'}\n\n`, 'utf-8');

    child.unref();
    ensureBackgroundTaskMonitor();

    return [
      `命令已在后台启动 (id: ${id})`,
      `pid: ${child.pid ?? 'unknown'}`,
      `cwd: ${cwdResult.cwd}`,
      `输出文件: ${outputPath}`,
      `输出上限: ${formatSize(MAX_BACKGROUND_OUTPUT_BYTES)}，超过后会自动终止进程。`,
      `查看输出: background_tasks_read(task_id="${id}")`,
      `等它结束: wait_for(kind="task", task_id="${id}")`,
      `终止任务: background_tasks_kill(task_id="${id}")`,
    ].join('\n');
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    const cmd = (input.command ?? '') as string;
    // "$ " prefix + " [后台]" suffix 大约占 10 个额外字符
    return `$ ${truncateDisplayText(cmd.trim(), 10)} [后台]`;
  }
}

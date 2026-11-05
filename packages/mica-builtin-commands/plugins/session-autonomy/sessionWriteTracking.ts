import { micaTools } from '@packages/mica-tools/index.js';
import type { ToolInput } from '@packages/mica-tools/index.js';
import { recordSessionWrite } from '@packages/mica-session/index.js';
import type { CommandRuntimeServices } from '@packages/mica-builtin-commands/index.js';
import type { SessionPeerDeps } from './sessionPeers.js';

/**
 * 把「这个会话写过哪些文件」记进 per-session 台账。
 *
 * 起因是一类真实事故：同一个工作目录上同时跑着几个会话，主会话用 `git status` 看到
 * 一批没提交的改动，误判成自己子代理越界，于是把整个文件还原成 HEAD——别的会话正在
 * 写的东西就这么没了。`git status` 不带作者，所以这个判断无从证伪。
 *
 * 这里只记录**工具写过的绝对路径**，不解析内容、不猜意图。`run_shell` 里的重定向
 * （`git show HEAD:x > x` 这类）看不见，所以台账是证据之一，不是绝对真相——读它的人
 * 该按「可能不是我的」而不是「一定是别人的」来用。
 */

const PATCH_FILE_HEADER = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/;
const PATCH_MOVE_HEADER = /^\*\*\* Move to: (.+)$/;

/** 从写类工具的输入里取出它要写的路径；非写类工具返回空数组。 */
export function extractWrittenPaths(toolName: string, input: ToolInput): string[] {
  if (toolName === 'write_file') {
    const filePath = input.file_path;
    return typeof filePath === 'string' && filePath.length > 0 ? [filePath] : [];
  }
  if (toolName === 'apply_patch') {
    const patch = input.patch;
    if (typeof patch !== 'string') return [];
    const paths: string[] = [];
    for (const line of patch.split('\n')) {
      const match = PATCH_FILE_HEADER.exec(line) ?? PATCH_MOVE_HEADER.exec(line);
      if (match?.[1]) paths.push(match[1]);
    }
    return paths;
  }
  return [];
}

/**
 * 这次工具调用属于哪条会话。
 *
 * 桌面端一个进程里能同时挂多条会话，所以「当前会话」不等于「正在执行工具的会话」：
 * 先用 context 里的 agent 身份去运行中的会话里对号，对不上才退回当前会话。
 */
export function resolveWriterSessionId(
  services: CommandRuntimeServices,
  context: unknown,
): string | undefined {
  const agent = (context as { agent?: { taskOwnerId?: unknown } } | undefined)?.agent;
  const ownerKey = typeof agent?.taskOwnerId === 'string' && agent.taskOwnerId ? agent.taskOwnerId : undefined;
  if (ownerKey) {
    const record = services.listRunningAgents?.().find((item) => item.taskOwnerId === ownerKey);
    if (record?.id) return record.id;
  }
  return services.getCurrentAgentSessionId?.();
}

export type SessionWriteRecorder = (sessionId: string, paths: string[]) => void;

export function installSessionWriteTracking(
  deps: Pick<SessionPeerDeps, 'services'>,
  record: SessionWriteRecorder = recordSessionWrite,
): { dispose(): void } {
  return micaTools.observeExecution({
    after(event) {
      if (event.error !== undefined) return;
      const paths = extractWrittenPaths(event.name, event.input);
      if (paths.length === 0) return;
      const sessionId = resolveWriterSessionId(deps.services, event.callbacks?.context);
      if (!sessionId) return;
      try {
        record(sessionId, paths);
      } catch {
        // 归因是辅助信息，任何失败都不该影响工具结果。
      }
    },
  });
}

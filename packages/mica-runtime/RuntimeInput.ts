import { micaCommon } from '@packages/mica-common/index.js';

export type RuntimeInputSource = 'ui' | 'plugin' | 'command' | 'system';
export type RuntimeQueueMode = 'after_iteration' | 'after_turn';

export type RuntimeInput = {
  id: string;
  text: string;
  /** Optional already-normalized multimodal content for protocol adapters. */
  content?: unknown;
  displayText?: string;
  source: RuntimeInputSource;
  createdAt: number;
  queueMode?: RuntimeQueueMode;
  /**
   * 接续一轮被宿主暂停、尚未跑完的对话：不追加用户消息，也不在会话记录里
   * 多出一条，直接对现有历史再发一次请求。`text` 此时只作为日志标识。
   */
  resume?: boolean;
};

export function createRuntimeInput(
  text: string,
  source: RuntimeInputSource = 'ui',
  options: {
    queueMode?: RuntimeQueueMode;
    displayText?: string;
    id?: string;
    content?: unknown;
    resume?: boolean;
  } = {},
): RuntimeInput {
  return {
    id: options.id ?? micaCommon.createId('input'),
    text,
    ...(options.content !== undefined ? { content: options.content } : {}),
    ...(options.displayText ? { displayText: options.displayText } : {}),
    source,
    createdAt: Date.now(),
    ...(options.queueMode ? { queueMode: options.queueMode } : {}),
    ...(options.resume ? { resume: true } : {}),
  };
}

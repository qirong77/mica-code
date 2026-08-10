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
};

export function createRuntimeInput(
  text: string,
  source: RuntimeInputSource = 'ui',
  options: { queueMode?: RuntimeQueueMode; displayText?: string; id?: string; content?: unknown } = {},
): RuntimeInput {
  return {
    id: options.id ?? micaCommon.createId('input'),
    text,
    ...(options.content !== undefined ? { content: options.content } : {}),
    ...(options.displayText ? { displayText: options.displayText } : {}),
    source,
    createdAt: Date.now(),
    ...(options.queueMode ? { queueMode: options.queueMode } : {}),
  };
}

import { micaCommon } from '@packages/mica-common/index.js';

export type RuntimeInputSource = 'ui' | 'plugin' | 'command' | 'system';
export type RuntimeQueueMode = 'after_iteration' | 'after_turn';

export type RuntimeInput = {
  id: string;
  text: string;
  displayText?: string;
  source: RuntimeInputSource;
  createdAt: number;
  queueMode?: RuntimeQueueMode;
};

export function createRuntimeInput(
  text: string,
  source: RuntimeInputSource = 'ui',
  options: { queueMode?: RuntimeQueueMode; displayText?: string } = {},
): RuntimeInput {
  return {
    id: micaCommon.createId('input'),
    text,
    ...(options.displayText ? { displayText: options.displayText } : {}),
    source,
    createdAt: Date.now(),
    ...(options.queueMode ? { queueMode: options.queueMode } : {}),
  };
}

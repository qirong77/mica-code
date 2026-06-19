import { micaCommon } from '@packages/mica-common/index.js';

export type RuntimeInputSource = 'ui' | 'plugin' | 'command' | 'system';

export type RuntimeInput = {
  id: string;
  text: string;
  source: RuntimeInputSource;
  createdAt: number;
};

export function createRuntimeInput(text: string, source: RuntimeInputSource = 'ui'): RuntimeInput {
  return {
    id: micaCommon.createId('input'),
    text,
    source,
    createdAt: Date.now(),
  };
}

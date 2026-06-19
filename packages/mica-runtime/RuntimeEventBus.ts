import { micaCommon } from '@packages/mica-common/index.js';
import type { RuntimeEvent, RuntimeEventMap } from './RuntimeEvent.js';

export class RuntimeEventBus extends micaCommon.TypedEventBus<RuntimeEventMap> {
  publish(event: RuntimeEvent): void {
    this.emit('event', event);
  }
}

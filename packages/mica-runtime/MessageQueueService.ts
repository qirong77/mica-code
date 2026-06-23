import type { RuntimeInput } from './RuntimeInput.js';

export class MessageQueueService {
  private item: RuntimeInput | null = null;

  enqueue(input: RuntimeInput): boolean {
    if (this.item) return false;
    this.item = input;
    return true;
  }

  dequeue(): RuntimeInput | null {
    const item = this.item;
    this.item = null;
    return item;
  }

  dequeueByMode(mode: RuntimeInput['queueMode']): RuntimeInput | null {
    if (!this.item || this.item.queueMode !== mode) return null;
    return this.dequeue();
  }

  removeLast(): RuntimeInput | null {
    return this.dequeue();
  }

  clear(): void {
    this.item = null;
  }

  list(): RuntimeInput[] {
    return this.item ? [this.item] : [];
  }

  count(): number {
    return this.item ? 1 : 0;
  }
}

import type { RuntimeInput } from './RuntimeInput.js';

export class MessageQueueService {
  private item: RuntimeInput | null = null;
  private iterationBoundaryInputId: string | null = null;

  enqueue(input: RuntimeInput): boolean {
    if (this.item) return false;
    this.item = input;
    return true;
  }

  dequeue(): RuntimeInput | null {
    const item = this.item;
    this.item = null;
    this.iterationBoundaryInputId = null;
    return item;
  }

  dequeueByMode(mode: RuntimeInput['queueMode']): RuntimeInput | null {
    if (!this.item || this.item.queueMode !== mode) return null;
    return this.dequeue();
  }

  /**
   * The first boundary only starts the wait. A second boundary proves that a
   * complete provider/tool iteration ran after this input was queued.
   */
  dequeueAfterCompletedIteration(allowDequeue = true): RuntimeInput | null {
    if (!this.item || this.item.queueMode !== 'after_iteration') return null;
    if (this.iterationBoundaryInputId !== this.item.id) {
      this.iterationBoundaryInputId = this.item.id;
      return null;
    }
    if (!allowDequeue) return null;
    return this.dequeue();
  }

  removeLast(): RuntimeInput | null {
    return this.dequeue();
  }

  clear(): void {
    this.item = null;
    this.iterationBoundaryInputId = null;
  }

  list(): RuntimeInput[] {
    return this.item ? [this.item] : [];
  }

  count(): number {
    return this.item ? 1 : 0;
  }
}

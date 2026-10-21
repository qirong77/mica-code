import type { RuntimeInput } from './RuntimeInput.js';

/**
 * How long a hold lasts without being refreshed. A hold only covers a client
 * round-trip (recall the queued input into the composer), so it must expire on
 * its own: a client that crashed between `hold` and `recall` would otherwise
 * strand the input in the queue forever, looking permanently "waiting to send".
 */
export const QUEUE_HOLD_TTL_MS = 60_000;

export class MessageQueueService {
  private item: RuntimeInput | null = null;
  private iterationBoundaryInputId: string | null = null;
  private hold: { id: string; until: number } | null = null;

  enqueue(input: RuntimeInput): boolean {
    if (this.item) return false;
    this.item = input;
    return true;
  }

  dequeue(): RuntimeInput | null {
    const item = this.item;
    this.item = null;
    this.iterationBoundaryInputId = null;
    this.hold = null;
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
    // A held input must not be injected: the user is pulling it back into the
    // composer and would otherwise watch the text they are editing get sent.
    // The boundary marker is left untouched so the wait restarts after release.
    if (this.isHeld()) return null;
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
    this.hold = null;
  }

  /**
   * Freeze the queued input so no iteration boundary can consume it while the
   * client moves it back into the composer (the recall round-trip), which is
   * what keeps a message the user is re-editing from being sent mid-edit.
   * Only the after_iteration injection is held: an explicit after_turn input is
   * drained when the turn ends, and holding it there could strand it with
   * nothing left to drain it.
   *
   * Returns false when the slot no longer holds that id (already injected /
   * recalled), so the client can tell "frozen" from "you are too late".
   */
  holdQueued(id: string | undefined, ttlMs = QUEUE_HOLD_TTL_MS): boolean {
    if (!this.item) return false;
    if (id && this.item.id !== id) return false;
    this.hold = { id: this.item.id, until: Date.now() + ttlMs };
    return true;
  }

  releaseQueued(id: string | undefined): boolean {
    if (!this.hold) return false;
    if (id && this.hold.id !== id) return false;
    this.hold = null;
    return true;
  }

  isHeld(): boolean {
    if (!this.hold) return false;
    if (Date.now() >= this.hold.until) {
      this.hold = null;
      return false;
    }
    return true;
  }

  list(): RuntimeInput[] {
    return this.item ? [this.item] : [];
  }

  count(): number {
    return this.item ? 1 : 0;
  }
}

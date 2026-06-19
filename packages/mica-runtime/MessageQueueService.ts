import type { RuntimeInput } from './RuntimeInput.js';

export class MessageQueueService {
  private readonly items: RuntimeInput[] = [];

  enqueue(input: RuntimeInput): void {
    this.items.push(input);
  }

  dequeue(): RuntimeInput | null {
    return this.items.shift() ?? null;
  }

  removeLast(): RuntimeInput | null {
    return this.items.pop() ?? null;
  }

  clear(): void {
    this.items.length = 0;
  }

  list(): RuntimeInput[] {
    return [...this.items];
  }

  count(): number {
    return this.items.length;
  }
}

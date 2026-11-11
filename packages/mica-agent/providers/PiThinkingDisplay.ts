/** Order display updates by content block, without reimplementing a provider's reasoning protocol. */
export class PiThinkingDisplay {
  private readonly parts: Array<{ index: number; text: string; emitted: number; done: boolean }> = [];
  private next = 0;
  private hasVisiblePart = false;
  private safe = true;

  constructor(private readonly emit: (delta: string) => void, private readonly checkpoint: () => void, private readonly checkStopped: () => void) {}

  start(index: number): void {
    if (!this.parts.some((part) => part.index === index)) this.parts.push({ index, text: '', emitted: 0, done: false });
  }

  delta(index: number, delta: string): void {
    this.start(index);
    const part = this.parts.find((entry) => entry.index === index)!;
    part.text += delta;
    this.flush();
  }

  end(index: number, content: string): void {
    this.start(index);
    const part = this.parts.find((entry) => entry.index === index)!;
    if (part.done) return;
    if (content.startsWith(part.text)) part.text = content;
    else this.safe = false;
    part.done = true;
    this.flush();
  }

  get complete(): boolean { return this.safe && this.parts.every((part) => part.done); }

  private flush(): void {
    while (this.next < this.parts.length) {
      const part = this.parts[this.next]!;
      const delta = part.text.slice(part.emitted);
      if (delta) {
        this.checkStopped();
        if (!part.emitted && this.hasVisiblePart) this.emit('\n\n');
        this.checkStopped();
        this.emit(delta);
        this.checkStopped();
        part.emitted = part.text.length;
      }
      if (!part.done) return;
      if (part.text) this.hasVisiblePart = true;
      this.checkStopped();
      if (this.safe) this.checkpoint();
      this.next++;
    }
  }
}

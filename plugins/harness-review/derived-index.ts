import type { Stats } from 'node:fs';

/** Disposable, per-recorder indexes. Values must be projections, never JSONL/body strings.
 * File identity (including ctime) prevents same-size edits, rotation and replacement from
 * reusing old results. A new recorder/root or classifier revision starts cold; no user-data
 * format is changed and there is nothing to migrate. */
export function fileSignature(info: Stats): string {
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
}

export class ProjectionIndex<T> {
  private readonly entries = new Map<string, { signature: string; value: T; bytes: number }>();
  private bytes = 0;

  constructor(private readonly maxEntries: number, private readonly maxBytes: number) {}

  get(key: string, signature: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.signature !== signature) {
      this.bytes -= entry.bytes;
      return undefined;
    }
    this.entries.set(key, entry);
    return structuredClone(entry.value);
  }

  set(key: string, signature: string, value: T): void {
    const previous = this.entries.get(key);
    if (previous) this.bytes -= previous.bytes;
    this.entries.delete(key);
    const bytes = Buffer.byteLength(JSON.stringify(value)) + key.length + signature.length;
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { signature, value: structuredClone(value), bytes });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
  }

  retain(keys: Set<string>): void {
    for (const [key, entry] of this.entries) {
      if (keys.has(key)) continue;
      this.entries.delete(key);
      this.bytes -= entry.bytes;
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}

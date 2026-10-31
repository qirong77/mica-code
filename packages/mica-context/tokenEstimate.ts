import { Buffer } from 'node:buffer';

/** A local estimate for budgeting; provider-reported usage remains the billing source. */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  // Native byte counting avoids a JS scan or a second multi-megabyte string.
  // ASCII uses ~4 chars/token. A three-byte CJK character contributes ~1.5
  // tokens; other non-ASCII scripts receive the same conservative weighting.
  const nonAsciiBytes = Buffer.byteLength(text, 'utf8') - text.length;
  return Math.ceil(text.length / 4 + nonAsciiBytes * 0.625);
}

/** Estimates structured provider messages without serializing or copying their payloads. */
export function estimateContextTokens(messages: readonly unknown[]): number {
  const visiting = new Set<object>();
  function estimate(value: unknown): number {
    if (typeof value === 'string') return estimateTextTokens(value);
    if (value === null || value === undefined) return 0;
    if (typeof value !== 'object') return 1;
    if (visiting.has(value)) return 0;
    visiting.add(value);
    let tokens = 0;
    if (Array.isArray(value)) {
      for (const item of value) tokens += estimate(item);
    } else {
      for (const [key, child] of Object.entries(value)) tokens += estimateTextTokens(key) + estimate(child) + 1;
    }
    visiting.delete(value);
    return tokens;
  }
  let total = 0;
  for (const message of messages) total += estimate(message) + 6;
  return total;
}

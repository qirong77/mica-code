/**
 * Capacity budgets for the first remote version.
 *
 * These are deliberately conservative and enforced by all three parties (the
 * machine, the controller, and the relay). They control payload size and
 * frequency; they are not a claim about any monitoring threshold.
 */
export const REMOTE_LIMITS = {
  /** One relay frame, including the JSON envelope and base64 ciphertext. */
  maxFrameBytes: 64 * 1024,
  /** A single history page's projected messages. */
  maxHistoryPageBytes: 32 * 1024,
  /** A bounded text preview (reserved for the next stage). */
  maxPreviewBytes: 8 * 1024,
  /** Refuse to parse a session file larger than this; the owner sees a clear error. */
  maxSessionFileBytes: 16 * 1024 * 1024,
  /** Directory payload published by one machine. */
  maxDirectoryBytes: 24 * 1024,
  maxSessionsPerWorkspace: 200,
  maxWorkspacesPerMachine: 16,
  /** Pairing request/accept payloads are tiny by construction. */
  maxPairingBytes: 4 * 1024,
  maxPairingNameChars: 80,
  /** One WebSocket per enabled machine; keepalive traffic stays low. */
  heartbeatMs: 30_000,
  /** A peer with no traffic for this long is treated as unreachable. */
  presenceTimeoutMs: 90_000,
  /** Controller message budget (token bucket). */
  rateBurst: 20,
  ratePerSecond: 4,
  /** Concurrent read-only RPCs per controller. */
  maxConcurrentReads: 4,
  /** Relay keeps only the latest directory per machine. */
  maxMachinesPerRelay: 64,
  /** Local cache of paired machines. */
  maxKnownMachines: 32,
} as const;

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Truncate on a UTF-8 boundary without adding an ellipsis. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: '', truncated: text.length > 0 };
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return { text: buffer.subarray(0, end).toString('utf8'), truncated: true };
}

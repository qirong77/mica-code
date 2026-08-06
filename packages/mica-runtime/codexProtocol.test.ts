import { describe, expect, it } from 'vitest';
import {
  CODEX_ERROR_METHOD_NOT_FOUND,
  encodeCodexError,
  encodeCodexNotification,
  encodeCodexResponse,
  parseCodexLine,
} from './codexProtocol.js';

describe('codex protocol framing', () => {
  it('parses a JSON-RPC request with id/method/params', () => {
    expect(parseCodexLine('{"id":1,"method":"turn/start","params":{"threadId":"t"}}')).toEqual({
      id: 1,
      method: 'turn/start',
      params: { threadId: 't' },
    });
  });

  it('parses a string request id', () => {
    expect(parseCodexLine('{"id":"a","method":"initialize"}')).toEqual({
      id: 'a',
      method: 'initialize',
      params: undefined,
    });
  });

  it('parses a client notification (no id)', () => {
    expect(parseCodexLine('{"method":"initialized"}')).toEqual({ method: 'initialized' });
  });

  it('parses responses and errors', () => {
    expect(parseCodexLine('{"id":1,"result":{"ok":true}}')).toEqual({ id: 1, result: { ok: true } });
    expect(parseCodexLine('{"id":2,"error":{"code":-32601,"message":"nope"}}')).toEqual({
      id: 2,
      error: { code: -32601, message: 'nope' },
    });
  });

  it('returns undefined for malformed shapes and throws on invalid JSON', () => {
    expect(parseCodexLine('{"foo":1}')).toBeUndefined();
    expect(() => parseCodexLine('not json')).toThrow();
  });

  it('encodes responses, errors and notifications as single NDJSON lines', () => {
    expect(encodeCodexResponse(1, { ok: true })).toBe('{"id":1,"result":{"ok":true}}\n');
    expect(encodeCodexError(2, CODEX_ERROR_METHOD_NOT_FOUND, 'nope')).toBe(
      '{"id":2,"error":{"code":-32601,"message":"nope"}}\n',
    );
    const notification = encodeCodexNotification('turn/started', { threadId: 't' });
    const parsed = JSON.parse(notification.trim());
    expect(parsed.method).toBe('turn/started');
    expect(parsed.params).toEqual({ threadId: 't' });
    expect(typeof parsed.emittedAtMs).toBe('number');
  });
});

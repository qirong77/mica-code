import { describe, expect, it } from 'vitest';
import {
  CODEX_METHODS,
  CODEX_ERROR_METHOD_NOT_FOUND,
  MICA_BTW_NOTIFICATIONS,
  MICA_CAPABILITY_NOTIFICATIONS,
  MICA_METHODS,
  MICA_NOTES_NOTIFICATIONS,
  encodeCodexError,
  encodeCodexNotification,
  encodeCodexResponse,
  parseCodexLine,
} from './codexProtocol.js';

describe('codex protocol framing', () => {
  it('advertises the standard thread resume method', () => {
    expect(CODEX_METHODS.threadResume).toBe('thread/resume');
  });

  // The desktop host sends these literal method names to `mica app-server`;
  // renaming one side silently turns the request into method-not-found.
  it('pins the Mica extension request names', () => {
    expect(MICA_METHODS).toEqual({
      editMessage: 'mica/turn/editMessage',
      queueRecall: 'mica/queue/recall',
      queueHold: 'mica/queue/hold',
      killBackgroundTask: 'mica/backgroundTasks/kill',
      backgroundTaskOutput: 'mica/backgroundTasks/output',
      subagentTaskDetail: 'mica/subagentTasks/detail',
      killSubagentTask: 'mica/subagentTasks/kill',
      btwAsk: 'mica/btw/ask',
      btwCompact: 'mica/btw/compact',
      btwInterrupt: 'mica/btw/interrupt',
      btwRecall: 'mica/btw/recall',
      btwThreads: 'mica/btw/threads',
      btwClose: 'mica/btw/close',
      renameSession: 'mica/session/rename',
      capabilitiesGet: 'mica/capabilities/get',
      capabilitiesSet: 'mica/capabilities/set',
      notesGet: 'mica/notes/get',
      pluginSettingsGet: 'mica/pluginSettings/get',
      pluginSettingsSet: 'mica/pluginSettings/set',
      notesSet: 'mica/notes/set',
    });
  });

  // 会话能力开关与笔记面板都靠这几条通知刷新：改名等于面板静默不更新。
  it('pins the Mica capability and notes notification names', () => {
    expect(MICA_CAPABILITY_NOTIFICATIONS).toEqual({ updated: 'mica/capabilities/updated' });
    expect(MICA_NOTES_NOTIFICATIONS).toEqual({ updated: 'mica/notes/updated' });
  });

  // Same reason: the desktop host matches this literal string to route a By The Way
  // (btw) answer into the panel; renaming one side silently drops every answer.
  it('pins the Mica btw notification name', () => {
    expect(MICA_BTW_NOTIFICATIONS).toEqual({ updated: 'mica/btw/updated' });
  });

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

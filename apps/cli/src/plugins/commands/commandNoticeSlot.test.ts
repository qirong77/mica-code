import { describe, expect, it } from 'vitest';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';
import { upsertCommandNotice } from './commandRuntimeServices.js';

function notice(content: string, command = 'session-compact', status?: 'running' | 'success' | 'info') {
  return { role: 'notice' as const, content, command, status };
}

const user: MicaUiConversationMessage = { role: 'user', content: 'one' };
const answer: MicaUiConversationMessage = { role: 'assistant', content: 'answer' };

describe('upsertCommandNotice', () => {
  it('keeps a single row for status notices that ask to replace', () => {
    const messages: MicaUiConversationMessage[] = [
      user,
      notice('会话压缩：500K → 90K', 'session-compact', 'success'),
      answer,
    ];

    const next = upsertCommandNotice(messages, notice('会话压缩：680K → 145K', 'session-compact', 'success'), {
      replace: true,
    });

    // 旧结论撤掉、新的落在当前位置：留在旧位置等于把最新结论埋进已经滚过去的那段对话。
    expect(next.map((entry) => entry.content)).toEqual(['one', 'answer', '会话压缩：680K → 145K']);
  });

  it('still appends every event notice so command output stays a record', () => {
    const messages: MicaUiConversationMessage[] = [user, notice('提交成功 1', '/commit', 'success'), answer];

    const next = upsertCommandNotice(messages, notice('提交成功 2', '/commit', 'success'));

    expect(next.map((entry) => entry.content)).toEqual(['one', '提交成功 1', 'answer', '提交成功 2']);
  });

  it('replaces the running progress row that the same command left behind', () => {
    const messages: MicaUiConversationMessage[] = [user, notice('正在整理…', '/compact', 'running')];

    const next = upsertCommandNotice(messages, notice('已压缩', '/compact', 'success'));

    expect(next.map((entry) => entry.content)).toEqual(['one', '已压缩']);
  });
});

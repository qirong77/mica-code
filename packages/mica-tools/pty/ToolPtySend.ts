import { MicaTool } from '../MicaTool.js';
import type { ToolExecuteCallbacks } from '../MicaTool.js';
import { truncateDisplayText } from '../utils/display.js';
import { getPtyManager } from './shared.js';

const KEY_NAMES =
  'enter, esc, tab, shiftTab, up, down, left, right, home, end, pageUp, pageDown, backspace, delete, ' +
  'ctrlC, ctrlD, ctrlL, ctrlR, ctrlU, ctrlLeft, ctrlRight, altEnter';

export class ToolPtySend extends MicaTool {
  constructor() {
    super(
      'pty_send',
      '向 PTY 会话发送输入。可发送原始文本（text，如需要换行用 \\r）或命名按键（key）。' +
        'key 可选值：' +
        KEY_NAMES +
        '。',
      {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'pty_spawn 返回的会话 ID。' },
          text: { type: 'string', description: '要发送的原始文本字节（不含自动回车，换行请用 \\r）。' },
          key: { type: 'string', description: `命名按键，如 enter / esc / ctrlC。可选值：${KEY_NAMES}` },
        },
        required: ['session_id'],
      },
    );
  }

  async execute(
    input: { session_id: string; text?: string; key?: string },
    _callbacks?: ToolExecuteCallbacks,
  ): Promise<string> {
    if (input.text === undefined && input.key === undefined) {
      return 'pty_send 需要提供 text 或 key 之一。';
    }
    try {
      const manager = await getPtyManager();
      if (input.key !== undefined) {
        await manager.sendKey(input.session_id, input.key);
      }
      if (input.text !== undefined) {
        await manager.send(input.session_id, input.text);
      }
      return `已发送到会话 ${input.session_id}`;
    } catch (error) {
      return `pty_send 失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    const target = input.key !== undefined ? input.key : input.text;
    return `pty send ${truncateDisplayText(String(target ?? ''), 24)} → ${truncateDisplayText(String(input.session_id ?? ''), 10)}`;
  }
}

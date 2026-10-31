import { describe, expect, it } from 'vitest';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';
import setup from './index.js';

function copy(messages: MicaUiConversationMessage[]) {
  let run: (input: { action: string }) => { copyText?: string; message?: string };
  setup({
    pluginId: 'session-copy',
    session: {
      describe: () => ({ id: 'test-session', title: 'Test', cwd: '/workspace', model: 'test-model' }),
      messages: () => messages,
    },
    desktop: {
      sessionMenu: (value: { run: typeof run }) => {
        run = value.run;
      },
    },
  } as unknown as PluginContext);
  return run!({ action: 'copy' });
}

describe('session copy menu', () => {
  it('extracts each message body once while producing both the export and its count', () => {
    let reads = 0;
    const result = copy(Array.from({ length: 2_000 }, () => ({
      role: 'user' as const,
      get content() { reads += 1; return 'visible text'; },
    })));
    expect(result.message).toContain('已复制 2000 条对话');
    expect(reads).toBe(2_000);
  });

  it('counts exactly the turns present in the Markdown', () => {
    const result = copy([
      { role: 'user', content: '看图 [Image](/private/image.png)' },
      { role: 'assistant', content: '   ' },
      { role: 'notice', content: 'not a conversation' },
    ]);
    expect(result.message).toContain('已复制 1 条对话');
    expect(result.copyText).toContain('- 对话条数：1');
    expect(result.copyText).toContain('看图 [图片]');
    expect(result.copyText).not.toContain('/private/image.png');
  });

  it('uses the empty-conversation message when all role messages are empty', () => {
    const result = copy([{ role: 'assistant', content: '' }]);
    expect(result.message).toContain('还没有对话内容');
    expect(result.copyText).toContain('- 对话条数：0');
  });
});

import type { PluginContext } from '@packages/mica-plugin/index.js';
import { sessionMarkdown } from './markdown.js';

export { conversationTurns, describeModel, messageText, sessionMarkdown } from './markdown.js';
export type { SessionCopyMeta } from './markdown.js';

/**
 * 把当前会话复制成 Markdown。
 *
 * 复制的是**核心信息**：会话 id、工作目录、模型、以及用户与助手的对话原文。工具调用、
 * 思考过程与 notice 都不在里面——它们既不是这次对话的内容，粘贴出去也只会淹没重点。
 *
 * 内容由插件在会话的常驻宿主里拼好（那里才有会话快照），剪贴板由页面写：插件进程跑在
 * `mica app-server` 里，那里面没有剪贴板，也不该为三个平台各调一次系统命令。
 *
 * **不调用模型**：这里是确定性的拼装，同一份会话永远导出同一段文本——复制这类动作等一次
 * 模型请求（还可能被它改写）毫无意义，也会白白记账。
 */
export default function setup(ctx: PluginContext): void {
  if (!ctx.desktop?.sessionMenu) {
    // 清单声明了 `desktop.sessionMenu` 与 `requires: ['desktop']`：走到这里说明宿主没给
    // 菜单能力，注册不上等于功能不存在，不如如实报出来。
    ctx.health.report({
      level: 'warn',
      message: '宿主没有提供会话菜单能力，复制会话不可用',
      hint: '需要桌面端（mica app-server）启动的会话宿主',
    });
    return;
  }
  if (!ctx.session) throw new Error('session-copy requires ctx.session');

  const session = ctx.session;

  ctx.desktop.sessionMenu({
    run({ action }) {
      if (action !== 'copy') return { message: `未知动作：${action}` };
      const info = session.describe();
      if (!info?.id) return { message: '当前没有会话，先打开一条对话再复制。' };

      const messages = session.messages();
      const markdown = sessionMarkdown(
        {
          title: info.title,
          sessionId: info.id,
          cwd: info.cwd,
          role: info.role,
          provider: info.provider,
          model: info.model,
        },
        messages,
      );
      // 条数只数真正的对话：notice 之类不属于这次对话，数进去会让提示对不上剪贴板里的内容。
      const turns = messages.filter((message) => message.role === 'user' || message.role === 'assistant').length;
      if (turns === 0) return { copyText: markdown, message: '已复制路径与模型信息（还没有对话内容）' };
      return {
        copyText: markdown,
        message: `已复制 ${turns} 条对话（${markdown.length} 字符）`,
      };
    },
  });
}

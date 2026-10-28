import type { PluginContext } from '@packages/mica-plugin/index.js';
import { runCommitFlow } from './flow.js';
import { commitLlmProblem, readCommitSettings } from './settings.js';

/**
 * `commit` 命令：把当前工作区的改动变成一次提交。
 *
 * 三件事由插件自己决定，内核不再参与：
 * - 提交信息用哪个模型写（设置里跟随主配置，或指定接口/协议/模型）；
 * - 提交流程本身（摘要 → 模型 → add → commit → push）；
 * - 出错时给用户什么说法（健康状态 + 命令结果的 message）。
 *
 * 运行中也可以执行（`allowDuringTurn`）：把工作区里已经落盘的东西提交掉，是用户在
 * agent 跑着的时候很自然的一个动作。真正的并发风险由 git 自己兜（索引锁），
 * 与在内核里实现时一样。
 */
export default function setup(ctx: PluginContext): void {
  const dispose = ctx.commands.register({
    name: 'commit',
    description: '分析 Git 变化并提交、推送；提交信息由插件设置里的模型生成',
    allowDuringTurn: true,
    scope: 'local-only',
    pluginId: ctx.pluginId,
    async handler(_commandCtx, args) {
      const unsupported = args.trim();
      if (unsupported) {
        const error = new Error(`commit 不支持参数 ${unsupported}`);
        notify(ctx, 'error', `commit: 不支持参数 ${unsupported}`);
        return { ok: false, error };
      }

      const settings = readCommitSettings(ctx.settings.get());
      const llm = ctx.llm;
      const problem = commitLlmProblem(llm);
      if (problem || !llm) {
        ctx.health.report({ level: 'warn', message: problem ?? '', hint: '到配置页 Plugins → Git Commit 里补齐' });
        notify(ctx, 'warn', `commit: ${problem}`);
        return { ok: false, error: new Error(problem ?? '') };
      }

      const cwd = process.cwd();
      ctx.logger.info('commit:run', {
        cwd,
        llm: llm.describe(),
        push: settings.push,
      });
      const result = await runCommitFlow({
        cwd,
        message: { prompt: settings.prompt },
        llm,
        push: settings.push,
        onProgress: (text) => notify(ctx, 'info', text),
      });

      if (!result.ok) {
        // 「没有可提交的变化」这类状态不是故障：报成 warn 会把插件的健康状态一路标红。
        // 没有 code 就是执行期抛错（模型请求失败、git 命令失败）。
        const failed = result.code === undefined;
        if (failed) {
          ctx.health.report({
            level: 'error',
            message: `上一次提交失败：${result.error ?? '未知错误'}`,
            hint: '检查工作区状态与接口配置，然后重试',
          });
        }
        notify(ctx, failed ? 'error' : 'warn', `commit: ${result.error}`);
        return { ok: false, error: new Error(result.error ?? 'commit 失败'), data: result };
      }

      ctx.health.report({
        level: 'ok',
        message: `上一次提交成功：${result.commitHash ?? ''} ${result.subject ?? ''}`.trim(),
      });
      const text = successText(result, settings.push);
      notify(ctx, 'info', text);
      return { ok: true, message: text, data: result };
    },
  });
  ctx.onDispose(() => dispose.dispose());

  ctx.logger.info('commit:setup', { settingsPath: ctx.settings.path });
}

function notify(ctx: PluginContext, level: 'info' | 'warn' | 'error', message: string): void {
  ctx.events.publish({ type: 'notification', level, message });
}

function successText(
  result: {
    commitHash?: string;
    subject?: string;
    commitMessage?: string;
    pushed?: boolean;
  },
  pushEnabled: boolean,
): string {
  const head = result.pushed
    ? `已提交并推送 \`${result.commitHash}\`  ${result.subject ?? ''}`
    : `已提交 \`${result.commitHash}\`，${pushEnabled ? '未找到可推送的远程分支' : '已在设置里关掉推送'}  ${result.subject ?? ''}`;
  const body = result.commitMessage?.split('\n').slice(1).join('\n').trim();
  return body ? `${head}\n\n${body}` : head;
}

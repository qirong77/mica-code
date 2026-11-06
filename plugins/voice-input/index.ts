import type { PluginContext } from '@packages/mica-plugin/index.js';
import { openRecording, VoiceInputError } from './recording.js';
import { transcriptionConfig, transcribeRecording } from './transcribe.js';

export default function setup(ctx: PluginContext): void {
  if (!ctx.desktop?.panel || !ctx.settings) throw new Error('Voice Input 需要桌面面板与插件设置能力。');
  const settings = ctx.settings;
  let disposed = false;
  let active: AbortController | undefined;
  const paths = new Set<string>();
  const reportFailure = (error: unknown): string => {
    const message = error instanceof VoiceInputError ? error.message : '语音输入失败，请检查设置后重新录音。';
    ctx.health.report({ level: 'warn', message, hint: '在 Settings → Plugins → Voice Input 检查语音转写服务配置。' });
    return message;
  };
  ctx.onDispose(() => { disposed = true; active?.abort(); });
  ctx.desktop.panel({
    view: () => ({
      title: 'Voice Input',
      sections: [{
        id: 'help', title: '语音输入',
        text: '点击输入框旁的麦克风录音，结束后转成可编辑文字。每段最多 120 秒、10 MiB。请先在插件设置中配置语音转写服务。',
        actions: [{ id: 'check', label: '检查配置' }],
      }],
    }),
    async action({ action, values }) {
      if (action === 'check') {
        try {
          if (disposed) throw new VoiceInputError('Voice Input 已停用。');
          transcriptionConfig(settings.get());
          return { message: '语音转写配置格式有效；服务连通性将在录音转写时验证。' };
        } catch (error) {
          throw new VoiceInputError(reportFailure(error));
        }
      }
      if (action !== 'transcribe' && action !== 'discard') return { message: '未知的语音输入动作。' };
      const path = values?.path;
      if (typeof path === 'string' && paths.has(path)) return { message: '这段录音正在处理，请稍候。' };
      if (typeof path === 'string') paths.add(path);
      let recording: Awaited<ReturnType<typeof openRecording>> | undefined;
      let controller: AbortController | undefined;
      let result: { message?: string; compose?: string };
      try {
        recording = await openRecording(path);
        if (action === 'discard') result = { message: '已取消并清理录音。' };
        else {
          if (disposed) throw new VoiceInputError('Voice Input 已停用，请重新启用后录音。');
          if (active) throw new VoiceInputError('已有录音正在转写，请稍候再录。');
          controller = new AbortController();
          active = controller;
          const config = transcriptionConfig(settings.get());
          const blob = await recording.read();
          const text = await transcribeRecording(config, blob, recording.name, controller);
          ctx.health.clear();
          result = { compose: text };
        }
      } catch (error) {
        result = { message: reportFailure(error) };
      } finally {
        try {
          // Close before unlink for Windows; remove rechecks the file identity.
          await recording?.close();
          await recording?.remove();
        } catch (error) {
          result = { message: reportFailure(error) };
        }
        if (controller && active === controller) active = undefined;
        if (typeof path === 'string') paths.delete(path);
      }
      return result!;
    },
  });
}

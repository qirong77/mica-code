import { VoiceInputError } from './recording.js';

export const TRANSCRIPTION_TIMEOUT_MS = 35_000;
export type TranscriptionConfig = { endpoint: string; apiKey: string; model: string; language: string };

export function transcriptionConfig(values: Record<string, string>): TranscriptionConfig {
  let url: URL;
  try { url = new URL((values.baseUrl ?? 'https://api.openai.com/v1').trim()); }
  catch { throw new VoiceInputError('请在 Voice Input 设置中填写有效的语音转写服务地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new VoiceInputError('语音服务地址须使用 HTTP(S)，且不能包含用户名、密码、查询参数或片段。');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/audio/transcriptions')) url.pathname += '/audio/transcriptions';
  const model = (values.model ?? 'whisper-1').trim();
  const language = (values.language ?? 'zh').trim();
  const apiKey = (values.apiKey ?? '').trim();
  if (!model || model.length > 200 || /[\r\n]/.test(model)) {
    throw new VoiceInputError('请在 Voice Input 设置中填写语音识别模型。');
  }
  if (language && !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language)) {
    throw new VoiceInputError('语言请填写 zh、en 等语言代码，或留空自动识别。');
  }
  if (/[\r\n]/.test(apiKey)) throw new VoiceInputError('API Key 格式无效，请重新填写。');
  if (url.hostname === 'api.openai.com' && !apiKey) {
    throw new VoiceInputError('请在 Voice Input 设置中填写 OpenAI API Key；本地免鉴权服务可留空。');
  }
  return { endpoint: url.toString(), apiKey, model, language };
}

export async function transcribeRecording(
  config: TranscriptionConfig,
  blob: Blob,
  name: string,
  controller: AbortController,
): Promise<string> {
  const form = new FormData();
  form.append('file', blob, name);
  form.append('model', config.model);
  form.append('response_format', 'json');
  if (config.language) form.append('language', config.language);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let timedOut = false;
  const aborted = new Promise<never>((_, reject) => {
    abortListener = () => reject(new VoiceInputError(timedOut
      ? '语音转写超时，请缩短录音或检查语音服务后重试。'
      : '语音转写已取消，请重新录音。'));
    controller.signal.addEventListener('abort', abortListener, { once: true });
    if (controller.signal.aborted) abortListener();
    timeout = setTimeout(() => { timedOut = true; controller.abort(); }, TRANSCRIPTION_TIMEOUT_MS);
  });
  try {
    return await Promise.race([aborted, (async () => {
      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
        body: form,
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new VoiceInputError(`语音服务返回 HTTP ${response.status}，请检查地址、API Key、模型及服务额度。`);
      }
      let value: unknown;
      try { value = await response.json(); }
      catch { throw new VoiceInputError('语音服务返回了无法解析的结果，请确认支持 JSON 转写接口。'); }
      const text = value && typeof value === 'object' && 'text' in value ? value.text : undefined;
      if (typeof text !== 'string') throw new VoiceInputError('语音服务未返回转写文字，请确认接口兼容性。');
      if (!text.trim()) throw new VoiceInputError('没有识别到语音，请靠近麦克风并重新录音。');
      return text.trim();
    })()]);
  } catch (error) {
    if (error instanceof VoiceInputError) throw error;
    throw new VoiceInputError('无法连接语音转写服务，请检查网络及 Voice Input 设置。');
  } finally {
    clearTimeout(timeout);
    if (abortListener) controller.signal.removeEventListener('abort', abortListener);
  }
}

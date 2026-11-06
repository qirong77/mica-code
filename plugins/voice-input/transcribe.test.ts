import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceInputError } from './recording.js';
import { transcribeRecording, transcriptionConfig } from './transcribe.js';

const values = (patch: Record<string, string> = {}) => ({
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'whisper-1',
  language: 'zh',
  ...patch,
});

const audio = () => new Blob([new Uint8Array(8)], { type: 'audio/webm' });

function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(handler);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('transcription config', () => {
  it('completes a bare base URL into the transcriptions endpoint', () => {
    expect(transcriptionConfig(values()).endpoint).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(transcriptionConfig(values({ baseUrl: 'https://api.openai.com/v1/' })).endpoint)
      .toBe('https://api.openai.com/v1/audio/transcriptions');
  });

  it('keeps an explicit endpoint and allows local services without a key', () => {
    const config = transcriptionConfig(values({
      baseUrl: 'http://127.0.0.1:8080/audio/transcriptions',
      apiKey: '',
    }));
    expect(config).toMatchObject({
      endpoint: 'http://127.0.0.1:8080/audio/transcriptions',
      apiKey: '',
      model: 'whisper-1',
      language: 'zh',
    });
  });

  it('rejects unusable addresses and missing credentials', () => {
    expect(() => transcriptionConfig(values({ baseUrl: 'not a url' }))).toThrow(VoiceInputError);
    expect(() => transcriptionConfig(values({ baseUrl: 'ftp://example.com/v1' }))).toThrow('HTTP(S)');
    expect(() => transcriptionConfig(values({ baseUrl: 'https://user:pw@example.com/v1' }))).toThrow(VoiceInputError);
    expect(() => transcriptionConfig(values({ apiKey: '' }))).toThrow('API Key');
    expect(() => transcriptionConfig(values({ model: '' }))).toThrow('模型');
    expect(() => transcriptionConfig(values({ language: '中文' }))).toThrow('语言');
  });

  it('treats an empty language as automatic detection', () => {
    expect(transcriptionConfig(values({ language: '  ' })).language).toBe('');
  });
});

describe('transcribeRecording', () => {
  it('posts multipart audio and returns the trimmed transcript', async () => {
    const fetchMock = stubFetch(async () => json({ text: '  今天下午三点开会  ' }));
    const text = await transcribeRecording(transcriptionConfig(values()), audio(), 'clip.webm', new AbortController());

    expect(text).toBe('今天下午三点开会');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    const form = init.body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('language')).toBe('zh');
    expect(form.get('file')).toBeInstanceOf(File);
  });

  it('omits the Authorization header for keyless local services', async () => {
    const fetchMock = stubFetch(async () => json({ text: '你好' }));
    await transcribeRecording(
      transcriptionConfig(values({ baseUrl: 'http://127.0.0.1:8080/v1', apiKey: '' })),
      audio(),
      'clip.webm',
      new AbortController(),
    );
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers).toEqual({});
  });

  it('explains HTTP failures, bad payloads and silence', async () => {
    stubFetch(async () => json({ error: 'invalid key' }, 401));
    await expect(transcribeRecording(transcriptionConfig(values()), audio(), 'a.webm', new AbortController()))
      .rejects.toThrow('HTTP 401');

    stubFetch(async () => new Response('not json', { status: 200 }));
    await expect(transcribeRecording(transcriptionConfig(values()), audio(), 'a.webm', new AbortController()))
      .rejects.toThrow('无法解析');

    stubFetch(async () => json({ text: 42 }));
    await expect(transcribeRecording(transcriptionConfig(values()), audio(), 'a.webm', new AbortController()))
      .rejects.toThrow('未返回转写文字');

    stubFetch(async () => json({ text: '   ' }));
    await expect(transcribeRecording(transcriptionConfig(values()), audio(), 'a.webm', new AbortController()))
      .rejects.toThrow('没有识别到语音');
  });

  it('reports a network failure as a connection problem', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(transcribeRecording(transcriptionConfig(values()), audio(), 'a.webm', new AbortController()))
      .rejects.toThrow('无法连接语音转写服务');
  });

  it('turns an aborted request into a cancellation message', async () => {
    stubFetch(() => new Promise<Response>(() => {}));
    const controller = new AbortController();
    const pending = transcribeRecording(transcriptionConfig(values()), audio(), 'a.webm', controller);
    controller.abort();
    await expect(pending).rejects.toThrow('已取消');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { MAX_AUDIO_BYTES, createVoiceInput } from './recorder.js';

/** 可控的 MediaRecorder：stop() 同步交付最后一帧，与浏览器里的最终 onstop 顺序一致。 */
class FakeRecorder {
  static supported: string[] = ['audio/webm;codecs=opus'];
  static instances: FakeRecorder[] = [];

  static isTypeSupported(mime: string): boolean {
    return FakeRecorder.supported.includes(mime);
  }

  state = 'inactive';
  readonly mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly stream: unknown, options: { mimeType: string }) {
    this.mimeType = options.mimeType;
    FakeRecorder.instances.push(this);
  }

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.onstop?.();
  }

  emit(bytes: number): void {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) });
  }
}

type Task = { callback: () => void; ms: number; done: boolean };

/** 把定时器交给测试：能看到录满两分钟被自动停下，也不用真的等两分钟。 */
function fakeClock() {
  const tasks: Task[] = [];
  return {
    schedule(callback: () => void, ms: number) {
      const task = { callback, ms, done: false };
      tasks.push(task);
      return task;
    },
    unschedule(task: Task | null | undefined) {
      if (task) task.done = true;
    },
    run(ms: number) {
      for (const task of tasks.filter((item) => !item.done && item.ms === ms)) {
        task.done = true;
        task.callback();
      }
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function flush(times = 4) {
  for (let index = 0; index < times; index++) await tick();
}

function create(overrides: Record<string, unknown> = {}) {
  FakeRecorder.instances = [];
  const clock = fakeClock();
  const stopTrack = vi.fn();
  const stream = { getTracks: () => [{ stop: stopTrack }] };
  const appended: string[] = [];
  // 浏览器的 MediaRecorder / MediaStream 在 node 里没有实现，这里只提供状态机用到的部分。
  const control = createVoiceInput({
    mediaDevices: { getUserMedia: async () => stream },
    Recorder: FakeRecorder,
    secure: true,
    check: async () => {},
    upload: async () => ({ ok: true, path: '/tmp/attachments/recording.webm' }),
    transcribe: async () => '  你好，世界  ',
    discard: async () => {},
    appendText: (text: string) => appended.push(text),
    schedule: clock.schedule,
    unschedule: clock.unschedule,
    ...overrides,
  } as unknown as Parameters<typeof createVoiceInput>[0]);
  return { control, appended, clock, stopTrack, recorder: () => FakeRecorder.instances.at(-1) };
}

describe('voice input state machine', () => {
  it('records, stops and appends the trimmed transcript to the draft', async () => {
    const { control, appended, clock, recorder, stopTrack } = create();
    await control.start();
    expect(control.state().status).toBe('recording');
    expect(recorder()?.state).toBe('recording');

    clock.run(1000);
    recorder()?.emit(64);
    control.stop();
    await flush();

    expect(appended).toEqual(['你好，世界']);
    expect(control.state()).toMatchObject({ status: 'idle', error: '', retryable: false });
    // 结束录音就要放开麦克风，不能让系统的录音指示灯一直亮着。
    expect(stopTrack).toHaveBeenCalled();
  });

  it('refuses to record without a secure context', async () => {
    const getUserMedia = vi.fn();
    const { control } = create({ secure: false, mediaDevices: { getUserMedia } });
    await control.start();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(control.state().error).toContain('HTTPS');
  });

  it('explains a denied microphone permission', async () => {
    const { control } = create({
      mediaDevices: {
        getUserMedia: async () => {
          throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
        },
      },
    });
    await control.start();
    expect(control.state()).toMatchObject({ status: 'error', retryable: false });
    expect(control.state().error).toContain('麦克风权限');
  });

  it('reports an empty recording instead of uploading silence', async () => {
    const upload = vi.fn();
    const { control } = create({ upload });
    await control.start();
    control.stop();
    await flush();
    expect(upload).not.toHaveBeenCalled();
    expect(control.state().error).toContain('没有录到声音');
  });

  it('stops by itself when the recording reaches its limit', async () => {
    const { control, clock, appended, recorder } = create();
    await control.start();
    recorder()?.emit(64);
    clock.run(120_000);
    await flush();
    expect(appended).toEqual(['你好，世界']);
    expect(control.state().status).toBe('idle');
  });

  it('keeps the recording so a failed upload can be retried', async () => {
    let attempts = 0;
    const upload = vi.fn(async () => {
      attempts += 1;
      return attempts === 1
        ? { ok: false, error: '网络不稳定' }
        : { ok: true, path: '/tmp/attachments/recording.webm' };
    });
    const { control, appended, recorder } = create({ upload });
    await control.start();
    recorder()?.emit(64);
    control.stop();
    await flush();
    expect(control.state()).toMatchObject({ status: 'error', retryable: true });
    expect(control.state().error).toBe('网络不稳定');
    expect(appended).toEqual([]);

    control.retry();
    await flush();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(appended).toEqual(['你好，世界']);
    expect(control.state()).toMatchObject({ status: 'idle', retryable: false });
  });

  it('cancels a capture in flight, discards its upload and never edits the draft', async () => {
    let releaseUpload: ((value: { ok: boolean; path: string }) => void) | undefined;
    const upload = vi.fn(
      () =>
        new Promise<{ ok: boolean; path: string }>((resolve) => {
          releaseUpload = resolve;
        }),
    );
    const transcribe = vi.fn(async () => '不该出现的文字');
    const discard = vi.fn(async () => {});
    const { control, appended, clock, recorder } = create({ upload, transcribe, discard });
    await control.start();
    recorder()?.emit(64);
    clock.run(1000);
    control.stop();
    await flush(1);
    expect(control.state().status).toBe('processing');

    control.cancel();
    releaseUpload?.({ ok: true, path: '/tmp/attachments/recording.webm' });
    await flush();

    expect(transcribe).not.toHaveBeenCalled();
    expect(appended).toEqual([]);
    expect(discard).toHaveBeenCalledWith('/tmp/attachments/recording.webm');
    expect(control.state().status).toBe('idle');
  });

  it('drops a recording that grows past the upload limit', async () => {
    const { control, stopTrack, recorder } = create({ maxBytes: 4 });
    await control.start();
    recorder()?.emit(8);
    await flush(1);
    expect(control.state().error).toContain('10MB');
    expect(stopTrack).toHaveBeenCalled();
    expect(MAX_AUDIO_BYTES).toBe(10 * 1024 * 1024);
  });

  it('releases the microphone when disposed mid-recording', async () => {
    const { control, stopTrack } = create();
    await control.start();
    control.dispose();
    expect(stopTrack).toHaveBeenCalled();
    expect(control.state().status).toBe('idle');
  });
});

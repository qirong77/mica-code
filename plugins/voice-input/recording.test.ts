import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import { MAX_RECORDING_BYTES, VoiceInputError, openRecording } from './recording.js';

const attachments = () => join(resolveMicaHome(), 'attachments');
const recordingName = (extension = 'webm') => `${randomUUID()}-voice-input-${randomUUID()}.${extension}`;

function writeRecording(bytes: number, extension = 'webm'): string {
  mkdirSync(attachments(), { recursive: true });
  const path = join(attachments(), recordingName(extension));
  writeFileSync(path, new Uint8Array(bytes));
  return path;
}

const opened: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const recording of opened.splice(0)) await recording.close();
});

describe('openRecording', () => {
  it('reads a recording uploaded by this feature and removes it afterwards', async () => {
    const path = writeRecording(32, 'm4a');
    const recording = await openRecording(path);
    opened.push(recording);

    expect(recording.name).toBe(path.split('/').at(-1));
    const blob = await recording.read();
    expect(blob.type).toBe('audio/mp4');
    expect(blob.size).toBe(32);

    await recording.close();
    await recording.remove();
    await expect(openRecording(path)).rejects.toThrow(VoiceInputError);
  });

  it('refuses paths outside the attachment directory and foreign file names', async () => {
    const path = writeRecording(8);
    await expect(openRecording('/tmp/elsewhere.webm')).rejects.toThrow(VoiceInputError);
    await expect(openRecording(join(attachments(), 'clip.webm'))).rejects.toThrow(VoiceInputError);
    await expect(openRecording(join(attachments(), '..', 'recording.webm'))).rejects.toThrow(VoiceInputError);
    expect(path).toBeTruthy();
  });

  it('refuses a symlink even when it points inside the directory', async () => {
    const target = writeRecording(8);
    const link = join(attachments(), recordingName());
    symlinkSync(target, link);
    await expect(openRecording(link)).rejects.toThrow(VoiceInputError);
  });

  it('refuses an empty or oversized recording', async () => {
    const empty = writeRecording(0);
    const blank = await openRecording(empty);
    opened.push(blank);
    await expect(blank.read()).rejects.toThrow('录音为空');

    const oversized = writeRecording(MAX_RECORDING_BYTES + 1);
    const huge = await openRecording(oversized);
    opened.push(huge);
    await expect(huge.read()).rejects.toThrow('超过 10 MiB');
  });
});

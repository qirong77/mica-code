import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';

export const MAX_RECORDING_BYTES = 10 * 1024 * 1024;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const RECORDING_NAME = new RegExp(`^${UUID}-voice-input-${UUID}\\.(webm|m4a|ogg|wav)$`, 'i');
const MIME: Record<string, string> = {
  webm: 'audio/webm', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav',
};

export class VoiceInputError extends Error {}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && b.isFile() && b.nlink === 1;
}

/** Open only an upload owned by this feature. Never follow a supplied symlink. */
export async function openRecording(input: unknown): Promise<{
  read(): Promise<Blob>;
  remove(): Promise<void>;
  close(): Promise<void>;
  name: string;
}> {
  if (typeof input !== 'string' || !isAbsolute(input) || input !== resolve(input)) {
    throw new VoiceInputError('录音路径无效，请重新录音。');
  }
  const directory = join(resolveMicaHome(), 'attachments');
  const match = RECORDING_NAME.exec(basename(input));
  if (dirname(input) !== directory || !match) {
    throw new VoiceInputError('只能处理本次语音输入上传的录音。');
  }

  let handle: FileHandle | undefined;
  try {
    const canonicalHome = await realpath(resolveMicaHome());
    const canonicalDirectory = join(canonicalHome, 'attachments');
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
      || await realpath(directory) !== canonicalDirectory) throw new Error('directory');
    const before = await lstat(input);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || await realpath(input) !== join(canonicalDirectory, basename(input))) throw new Error('file');
    handle = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const identity = await handle.stat();
    if (!sameFile(before, identity)) throw new Error('changed');
    const recording = handle;
    return {
      name: basename(input),
      async read() {
        const stat = await recording.stat();
        if (!sameFile(identity, stat)) throw new VoiceInputError('录音文件已改变，请重新录音。');
        if (stat.size > MAX_RECORDING_BYTES) throw new VoiceInputError('录音超过 10 MiB，请缩短后重试。');
        if (stat.size === 0) throw new VoiceInputError('录音为空，请重新录音。');
        // One extra byte detects growth without an unbounded readFile allocation.
        const bytes = new Uint8Array(MAX_RECORDING_BYTES + 1);
        let size = 0;
        while (size < bytes.length) {
          const { bytesRead } = await recording.read(bytes, size, bytes.length - size, size);
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size > MAX_RECORDING_BYTES) throw new VoiceInputError('录音超过 10 MiB，请缩短后重试。');
        if (!size) throw new VoiceInputError('录音为空，请重新录音。');
        return new Blob([bytes.subarray(0, size)], { type: MIME[match[1]!.toLowerCase()] });
      },
      async remove() {
        // Recheck identity: a replaced upload must never be removed by this request.
        try {
          const currentDirectory = await lstat(directory);
          if (!sameDirectory(directoryStat, currentDirectory)
            || await realpath(directory) !== canonicalDirectory
            || !sameFile(identity, await lstat(input))) {
            throw new VoiceInputError('录音文件已改变，无法安全清理。');
          }
          await unlink(input);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw new VoiceInputError('录音临时文件清理失败，请检查本机附件目录权限。');
        }
      },
      close: () => recording.close(),
    };
  } catch {
    await handle?.close();
    throw new VoiceInputError('录音不存在或不是可安全读取的上传文件，请重新录音。');
  }
}

function sameDirectory(a: Stats, b: Stats): boolean {
  return b.isDirectory() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino;
}

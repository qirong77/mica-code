import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { access, chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import source from './native-source.js';

const execute = promisify(execFile);
const MAX_LINE_BYTES = 32 * 1024 * 1024;

/** Compile only our bundled source; nothing from clipboard data is ever executed. */
export async function prepareNative(directory, options = {}) {
  if ((options.platform ?? process.platform) !== 'darwin') throw new Error('Mica Maccy 的剪贴板监听需要 macOS');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const digest = createHash('sha256').update(source).update(process.arch).digest('hex').slice(0, 20);
  const executable = join(directory, `pasteboard-${digest}`);
  try {
    await access(executable, constants.X_OK);
    return executable;
  } catch {
    /* A new helper version is compiled once, then reused across launches. */
  }
  const temporary = `${executable}-${randomUUID()}`;
  const sourceFile = `${temporary}.m`;
  try {
    await writeFile(sourceFile, source, { mode: 0o600 });
    await (options.execute ?? execute)(
      '/usr/bin/clang',
      [
        '-x',
        'objective-c',
        '-fobjc-arc',
        '-fblocks',
        '-O2',
        '-Wno-deprecated-declarations',
        '-framework',
        'AppKit',
        '-framework',
        'ApplicationServices',
        sourceFile,
        '-o',
        temporary,
      ],
      { timeout: 90_000, maxBuffer: 64 * 1024, signal: options.signal },
    );
    await chmod(temporary, 0o700);
    await rename(temporary, executable);
    return executable;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error(
      '无法准备原生剪贴板组件。请安装 Xcode Command Line Tools（xcode-select --install），然后在插件中重试。',
    );
  } finally {
    await rm(sourceFile, { force: true });
    await rm(temporary, { force: true });
  }
}

/** One stdin/stdout AppKit process. EOF and a native parent-exit watch prevent orphans. */
export function createNativeBridge({ directory, onActivate = () => {}, onError = () => {}, ...options }) {
  let child = null;
  let starting = null;
  let disposed = false;
  let serial = 0;
  let capabilities = null;
  const pending = new Map();
  const lifetime = new AbortController();

  function rejectPending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }

  async function start() {
    if (disposed) throw new Error('剪贴板组件已关闭');
    if (starting) return starting;
    starting = (async () => {
      const executable = await (options.prepare ?? prepareNative)(directory, { ...options, signal: lifetime.signal });
      if (disposed) throw new Error('剪贴板组件已关闭');
      return new Promise((resolve, reject) => {
        const processChild = (options.spawn ?? spawn)(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
        child = processChild;
        let buffer = '';
        let ready = false;
        const timer = setTimeout(() => {
          processChild.kill();
          reject(new Error('原生剪贴板组件启动超时，请重试'));
        }, options.startTimeoutMs ?? 15_000);
        timer.unref?.();
        processChild.stdout.setEncoding('utf8');
        processChild.stdout.on('data', (chunk) => {
          buffer += chunk;
          if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
            processChild.kill();
            rejectPending(new Error('原生剪贴板响应超过大小限制'));
            return;
          }
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            let message;
            try {
              message = JSON.parse(line);
            } catch {
              continue;
            }
            if (message.event === 'ready') {
              capabilities = {
                supported: true,
                accessibility: message.accessibility === true,
                changeCount: message.changeCount,
              };
              ready = true;
              clearTimeout(timer);
              resolve(capabilities);
              continue;
            }
            if (message.event === 'activate') {
              Promise.resolve(
                onActivate?.({ altKey: message.altKey === true, shiftKey: message.shiftKey === true }),
              ).catch((error) => onError?.(error));
              continue;
            }
            const request = pending.get(message.id);
            if (!request) continue;
            pending.delete(message.id);
            clearTimeout(request.timer);
            if (message.ok && request.action === 'status') capabilities = { ...capabilities, ...message.result };
            // Permissions can change while the helper stays alive, even with an unchanged clipboard.
            // Keep only the capability here: poll results can also contain private clipboard payloads.
            if (message.ok && request.action === 'poll' && typeof message.result?.accessibility === 'boolean') {
              capabilities = { ...capabilities, accessibility: message.result.accessibility };
            }
            if (message.ok) request.resolve(message.result);
            else request.reject(new Error(message.error || '原生剪贴板操作未完成'));
          }
        });
        // Never forward native stderr: diagnostic output must not contain clipboard content.
        processChild.stderr.resume();
        processChild.stdin.on('error', () => {});
        processChild.on('error', () => {
          clearTimeout(timer);
          const error = new Error('无法启动原生剪贴板组件，请重试');
          reject(error);
          rejectPending(error);
          if (child === processChild) {
            child = null;
            starting = null;
            capabilities = null;
          }
        });
        processChild.on('close', () => {
          clearTimeout(timer);
          const error = new Error('原生剪贴板组件已退出，请重试');
          if (!ready) reject(error);
          rejectPending(error);
          if (child === processChild) {
            child = null;
            starting = null;
            capabilities = null;
          }
        });
      });
    })();
    const attempt = starting;
    try {
      return await attempt;
    } catch (error) {
      if (starting === attempt) starting = null;
      throw error;
    }
  }

  return {
    async request(action, input = {}) {
      await start();
      if (disposed || !child) throw new Error('剪贴板组件已关闭');
      const processChild = child;
      return new Promise((resolve, reject) => {
        const id = ++serial;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('原生剪贴板操作超时，请重试'));
          // A stalled helper must not later perform a timed-out paste/write.
          processChild.kill();
        }, options.requestTimeoutMs ?? 10_000);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer, action });
        processChild.stdin.write(`${JSON.stringify({ id, action, input })}\n`, (error) => {
          if (!error || !pending.has(id)) return;
          pending.delete(id);
          clearTimeout(timer);
          reject(new Error('无法连接原生剪贴板组件'));
        });
      });
    },
    start,
    capabilities: () => capabilities,
    async dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      rejectPending(new Error('剪贴板组件已关闭'));
      const processChild = child;
      if (!processChild) {
        await starting?.catch(() => {});
        return;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          processChild.kill('SIGKILL');
          resolve();
        }, 2_000);
        timer.unref?.();
        processChild.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        processChild.stdin.end();
        processChild.kill('SIGTERM');
      });
      child = null;
    },
  };
}

import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 非阻塞进程锁：每次申请先公布唯一 claim，再检查有没有其他活着的申请者。
 *
 * claim 的 pid 写在文件名里，因此空文件也能被识别；目录始终保留，不竞争删除目录。
 * 两个同时申请者允许都退让重试。成功者的 claim 在释放前一直存在，后来的申请者必定
 * 看见它。孤儿 claim 的名字永不复用，回收旧 claim 不会误删别人刚取得的新锁。
 */
export function acquireProcessLock(path: string): (() => void) | null {
  const directory = `${path}.owners`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const claim = `${process.pid}-${randomUUID()}`;
  const file = join(directory, claim);
  writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  const release = () => {
    try {
      unlinkSync(file);
    } catch {
      // 唯一文件只属于本次申请；释放可重复调用，也不会碰到后续持有者。
    }
  };
  try {
    for (const entry of readdirSync(directory)) {
      if (entry === claim) continue;
      const match = /^(\d+)-[a-f0-9-]{36}$/i.exec(entry);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0 || isAlive(pid)) {
        release();
        return null;
      }
      try {
        unlinkSync(join(directory, entry));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // 没权限探测时按活进程处理，不能据此解除别人的互斥。
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

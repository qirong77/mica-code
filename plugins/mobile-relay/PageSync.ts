import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * 把本机的页面产物同步到中转机。
 *
 * 中转机托管的是**桌面端的 renderer 产物**，Mica 一升级它就旧了：手机上打开的是上一版
 * 界面，还可能对着已经改过的接口发请求。以前只有一个办法——重新 SSH 部署一遍，那既不
 * 现实也没必要（页面之外的东西都没变）。
 *
 * 所以中转机多了一个 `/api/publish`：已登记机器凭口令 POST 一份 gzip 过的 tar，
 * 它对 `public/` 做原子替换。本机只需回答两个问题：这版和线上那版一样吗、不一样怎么传。
 *
 * 页面产物从哪来：`--renderer` / `MICA_DESKTOP_RENDERER` / 仓库的 `apps/desktop/out/renderer`。
 * **不**去抠 `app.asar` 里的产物——那只有 Electron 自己读得到，硬解出来是 hack。打包版由
 * 桌面端把 renderer 解包成普通目录再通过环境变量告诉这里。
 */

const execFileAsync = promisify(execFile);
/** 单个页面包的上限，和中转机那边的接收上限对齐。 */
const MAX_BUNDLE_BYTES = 96 * 1024 * 1024;

let versionMemo: { path: string; stamp: number; version: string } | null = null;

export type PageSyncOutcome =
  | { status: 'unsupported'; reason: string }
  | { status: 'current'; version: string }
  | { status: 'published'; version: string; bytes: number };

/** 这版页面的指纹：index.html 里的资源名带内容哈希，页面一变它就变。 */
export function pageVersionOf(dir: string | null): string | null {
  if (!dir) return null;
  const index = join(dir, 'index.html');
  if (!existsSync(index)) return null;
  try {
    // 状态每 3 秒刷一次，这里按 mtime 记住上一份，别反复读 4KB 再算哈希。
    const stamp = statSync(index).mtimeMs;
    if (versionMemo?.path === index && versionMemo.stamp === stamp) return versionMemo.version;
    const version = createHash('sha256').update(readFileSync(index)).digest('hex').slice(0, 12);
    versionMemo = { path: index, stamp, version };
    return version;
  } catch {
    return null;
  }
}

/**
 * 找一个能读的页面产物目录。
 *
 * 顺序有意义：显式设置优先（用户可能故意指向别处的构建），其次环境变量（桌面端解包出来的
 * 那份），最后才是仓库里的构建结果。
 */
export function resolveRendererDir(options: {
  explicit?: string;
  env?: string;
  cwd?: string;
  repoRoot?: string;
}): string | null {
  const candidates = [
    options.explicit,
    options.env,
    options.cwd ? join(options.cwd, 'apps', 'desktop', 'out', 'renderer') : '',
    options.repoRoot ? join(options.repoRoot, 'apps', 'desktop', 'out', 'renderer') : '',
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return null;
}

async function readRelayPageVersion(relayUrl: string, token: string): Promise<string | null> {
  try {
    const response = await fetch(`${relayUrl.replace(/\/+$/, '')}/api/health`, {
      headers: { 'x-relay-token': token },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { pageVersion?: unknown };
    return typeof body?.pageVersion === 'string' ? body.pageVersion : null;
  } catch {
    return null;
  }
}

/** 打包成 gzip tar；`.br`/`.gz` 是服务端产物，不该跟着上传。 */
async function packRenderer(dir: string): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    'tar',
    ['-czf', '-', '--exclude=*.br', '--exclude=*.gz', '-C', dir, '.'],
    { encoding: 'buffer', maxBuffer: MAX_BUNDLE_BYTES, timeout: 180_000 },
  );
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout as unknown as string);
}

export async function syncPage(options: {
  relayUrl: string;
  token: string;
  rendererDir: string | null;
  /** 上一次成功同步的版本，命中就不必再问中转机。 */
  lastSynced?: string;
}): Promise<PageSyncOutcome> {
  const version = pageVersionOf(options.rendererDir);
  if (!options.rendererDir || !version) {
    return {
      status: 'unsupported',
      reason: '找不到页面产物；打包版会随 Mica 一起更新，仓库里请先构建 apps/desktop',
    };
  }
  const remote = await readRelayPageVersion(options.relayUrl, options.token);
  if (remote === version) return { status: 'current', version };

  const bundle = await packRenderer(options.rendererDir);
  const response = await fetch(`${options.relayUrl.replace(/\/+$/, '')}/api/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/gzip', 'x-relay-token': options.token },
    // fetch 的 BodyInit 不认 Node 的 Buffer，转成 Uint8Array。
    body: new Uint8Array(bundle),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`中转机拒绝了这份页面（${response.status}）${detail ? `：${detail.slice(0, 200)}` : ''}`);
  }
  const body = (await response.json().catch(() => ({}))) as { pageVersion?: string };
  return { status: 'published', version: body.pageVersion || version, bytes: bundle.length };
}

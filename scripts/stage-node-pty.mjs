// 将 node-pty 精简复制到目标目录（发布包 / 本地安装共用）。
//
// node-pty 的原生加载顺序是 build/Release → build/Debug → prebuilds/{platform}-{arch}
// （见 node-pty/lib/utils.js 的 loadNativeModule）。npm 包自带 darwin / win32 的
// prebuilds，但没有 linux；linux 需要安装时编译（bun install 在 trustedDependencies
// 中执行 node-pty 的 install 脚本）。
//
// 因此：
// - darwin / win32 发布包：复制 prebuilds/{platform}-{arch}（pty.node + spawn-helper）
// - linux 发布包：复制安装时编译的 build/Release/{pty.node,spawn-helper}
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export function stageNodePty({ source = 'node_modules/node-pty', dest, platform, arch }) {
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    throw new Error(`不支持的 node-pty 目标平台: ${platform}`);
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });

  // 通用部分：JS 入口与包元数据
  cpSync(join(source, 'lib'), join(dest, 'lib'), { recursive: true });
  for (const file of ['package.json', 'README.md', 'LICENSE']) {
    const src = join(source, file);
    if (existsSync(src)) cpSync(src, join(dest, file));
  }

  if (platform === 'linux') {
    // CI 在对应架构 runner 上 bun install 时编译的原生产物
    const releaseDir = join(source, 'build', 'Release');
    for (const file of ['pty.node', 'spawn-helper']) {
      const src = join(releaseDir, file);
      if (!existsSync(src)) {
        throw new Error(
          `node-pty 缺少编译产物 ${src}。linux 发布包需要先在对应架构 runner 上 bun install 编译 node-pty（trustedDependencies）。`,
        );
      }
      cpSync(src, join(dest, 'build', 'Release', file));
    }
    return dest;
  }

  // darwin / win32：npm 包自带的 prebuilds
  const prebuildSrc = join(source, 'prebuilds', `${platform}-${arch}`);
  if (!existsSync(prebuildSrc)) {
    throw new Error(`node-pty 缺少 ${platform}-${arch} prebuild: ${prebuildSrc}`);
  }
  cpSync(prebuildSrc, join(dest, 'prebuilds', `${platform}-${arch}`), { recursive: true });
  return dest;
}

/** 修复 node-pty 原生辅助程序的可执行位（spawn-helper）。 */
export function chmodSpawnHelpers(ptyRoot, platform, arch) {
  for (const helper of [
    join(ptyRoot, 'prebuilds', `${platform}-${arch}`, 'spawn-helper'),
    join(ptyRoot, 'build', 'Release', 'spawn-helper'),
  ]) {
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}

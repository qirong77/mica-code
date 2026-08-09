// 发布包打包：mica 二进制 + node-pty 运行时 → tar.gz。
// 每个平台的 tar 都自带该平台可用的 node-pty，安装后开箱即用，不再依赖用户机器上的 node_modules。
//
// 用法（由 build-binaries.yml 调用）:
//   MICA_ASSET_NAME=mica-code-darwin-arm64 \
//   MICA_PTY_TARGET_OS=darwin MICA_PTY_TARGET_ARCH=arm64 \
//   MICA_BINARY=dist/release/mica-code-darwin-arm64 \
//   bun scripts/package-release.mjs
import { execSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chmodSpawnHelpers, stageNodePty } from './stage-node-pty.mjs';

const asset = process.env.MICA_ASSET_NAME;
if (!asset) throw new Error('需要 MICA_ASSET_NAME（如 mica-code-darwin-arm64）');
const ptyOs = process.env.MICA_PTY_TARGET_OS;
const ptyArch = process.env.MICA_PTY_TARGET_ARCH;
if (!ptyOs || !ptyArch) throw new Error('需要 MICA_PTY_TARGET_OS / MICA_PTY_TARGET_ARCH（darwin|linux / x64|arm64）');

const binary = process.env.MICA_BINARY ?? join('dist', 'release', asset);
if (!existsSync(binary)) throw new Error(`二进制不存在: ${binary}`);
const stageDir = join('dist', 'stage', asset);
const outDir = process.env.MICA_OUT_DIR ?? 'dist/packages';

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

// 1. 二进制（统一命名为 mica，install 时解压到 ~/.local/lib/mica/）
cpSync(binary, join(stageDir, 'mica'));
chmodSync(join(stageDir, 'mica'), 0o755);

// 2. node-pty 运行时（精简：只带该平台需要的原生部分）
const ptyRoot = join(stageDir, 'node_modules', 'node-pty');
stageNodePty({ dest: ptyRoot, platform: ptyOs, arch: ptyArch });
chmodSpawnHelpers(ptyRoot, ptyOs, ptyArch);

// 3. tar.gz（GZIP=-9 与旧发布一致）
const archive = join(outDir, `${asset}.tar.gz`);
execSync(`GZIP=-9 tar -czf ${JSON.stringify(archive)} -C ${JSON.stringify(stageDir)} .`, { stdio: 'inherit' });
console.log(`Packaged ${archive} (binary + node-pty for ${ptyOs}-${ptyArch})`);

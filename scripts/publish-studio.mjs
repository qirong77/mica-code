#!/usr/bin/env node
/**
 * 一键发布 Studio（studio 分支产物）到 @didi/spring-cli。
 *
 * 流程：typecheck → 构建 mica-code（产出 dist/studio）→ 复制二进制到 spring-cli
 *       → bump 版本号 → npm publish → 校验发布结果。
 *
 * 用法：
 *   bun run release:studio                    # patch 版本 +1（默认）
 *   bun run release:studio --minor            # minor 版本 +1
 *   bun run release:studio --major            # major 版本 +1
 *   bun run release:studio --version=1.10.0   # 指定版本号
 *   bun run release:studio --dry-run          # 只预览执行计划，不执行任何命令
 *   bun run release:studio --skip-typecheck   # 跳过 tsc
 *
 * 环境变量：
 *   SPRING_CLI_DIR   spring-cli 包目录，默认 ~/Desktop/VsGo-Projects/spring-cli/spring-cli
 */
import { execFileSync, execSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipTypecheck = args.includes('--skip-typecheck');
const versionArg = args.find((a) => a.startsWith('--version='));
const explicitVersion = versionArg ? versionArg.split('=')[1] : null;
const bumpMode = args.includes('--major') ? 'major' : args.includes('--minor') ? 'minor' : 'patch';

const springCliDir =
  process.env.SPRING_CLI_DIR ?? join(homedir(), 'Desktop', 'VsGo-Projects', 'spring-cli', 'spring-cli');
const pkgName = '@didi/spring-cli';
const studioBinary = join(repoRoot, 'dist', 'studio');
const studioTarget = join(springCliDir, 'dist', 'bin', 'studio');

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  if (dryRun) return;
  execSync(cmd, { stdio: 'inherit', ...opts });
}

// ── 0. 前置检查 ──────────────────────────────────────────────
const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8', cwd: repoRoot }).trim();
if (branch !== 'studio') {
  fail(`当前分支是 "${branch}"，Studio 产物应从 studio 分支发布（先切换分支再重试）。`);
}
if (!existsSync(join(springCliDir, 'package.json'))) {
  fail(`spring-cli 目录不存在：${springCliDir}\n    可用 SPRING_CLI_DIR 环境变量指定。`);
}

// ── 1. typecheck ────────────────────────────────────────────
if (!skipTypecheck) {
  console.log('\n▶ 1/6 typecheck');
  run('bun run typecheck', { cwd: repoRoot });
} else {
  console.log('\n▶ 1/6 typecheck（已跳过）');
}

// ── 2. 构建 mica-code，产出 dist/studio ─────────────────────
console.log('\n▶ 2/6 构建 mica-code');
run('bun run build', { cwd: repoRoot });
if (dryRun) {
  console.log('   （dry-run：跳过产物校验）');
} else if (!existsSync(studioBinary)) {
  fail(`构建产物不存在：${studioBinary}`);
}

// ── 3. 复制 studio 二进制到 spring-cli ──────────────────────
console.log('\n▶ 3/6 复制 studio 二进制');
if (dryRun) {
  console.log(`   ${studioBinary} → ${studioTarget}`);
} else {
  mkdirSync(dirname(studioTarget), { recursive: true });
  copyFileSync(studioBinary, studioTarget);
  chmodSync(studioTarget, 0o755);
  console.log(`   已复制：${studioTarget}`);
}

// ── 4. bump 版本号 ──────────────────────────────────────────
console.log('\n▶ 4/6 更新版本号');
const pkgFile = join(springCliDir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
const oldVersion = pkg.version;
const newVersion = explicitVersion ?? bumpVersion(oldVersion, bumpMode);
if (dryRun) {
  console.log(`   ${oldVersion} → ${newVersion}（dry-run 不写入）`);
} else {
  pkg.version = newVersion;
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`   ${oldVersion} → ${newVersion}`);
}

// ── 5. npm publish ──────────────────────────────────────────
console.log('\n▶ 5/6 npm publish');
if (dryRun) {
  console.log('   （dry-run：不执行 publish）');
} else {
  run('npm publish', { cwd: springCliDir });
}

// ── 6. 校验 ─────────────────────────────────────────────────
console.log('\n▶ 6/6 校验发布结果');
if (dryRun) {
  console.log('   （dry-run：跳过校验）');
} else {
  const published = execFileSync('npm', ['view', `${pkgName}@${newVersion}`, 'version'], { encoding: 'utf8' }).trim();
  if (published === newVersion) {
    console.log(`✅ @didi/spring-cli@${newVersion} 已发布成功`);
  } else {
    fail(`校验失败：registry 返回 "${published}"，期望 "${newVersion}"`);
  }
}

if (dryRun) {
  console.log('\n✅ dry-run 完成（未发布）。移除 --dry-run 执行正式发布。');
}

function bumpVersion(version, mode) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (mode === 'major') return `${major + 1}.0.0`;
  if (mode === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

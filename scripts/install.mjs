import { execSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chmodSpawnHelpers, stageNodePty } from './stage-node-pty.mjs';

const outFile = process.env.MICA_BUILD_OUTFILE ?? join('dist', process.env.MICA_BUILD_NAME ?? 'mica');
if (!existsSync(outFile)) {
  execSync('bun scripts/build.mjs', { stdio: 'inherit' });
}

const home = homedir();
const binName = process.env.MICA_BIN_NAME ?? 'mica';
// Keep the compiled binary in a stable location and expose it through a thin launcher.
const packageDir = process.env.MICA_INSTALL_PACKAGE_DIR ?? resolve(home, '.local/lib/mica');
const binDir = process.env.MICA_INSTALL_DIR ?? resolve(home, '.local/bin');

try {
  if (!existsSync(packageDir)) mkdirSync(packageDir, { recursive: true });
  if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });

  const installBinary = (name, file) => {
    const packagedBinary = join(packageDir, name);
    copyFileSync(file, packagedBinary);
    chmodSync(packagedBinary, 0o755);
    const launcher = join(binDir, name);
    writeFileSync(launcher, `#!/bin/sh\nexec "${packagedBinary}" "$@"\n`, { mode: 0o755 });
    chmodSync(launcher, 0o755);
    console.log(`Installed launcher to: ${launcher}`);
    console.log(`Packaged binary: ${packagedBinary}`);
  };

  installBinary(binName, outFile);

  // 复制 node-pty 运行时，让 PTY 工具不依赖用户机器上的 node_modules。
  // 旧版残留（如 sharp 时代的整个 node_modules）只清理 sharp，不再删 node-pty。
  const legacySharp = join(packageDir, 'node_modules', 'sharp');
  if (existsSync(legacySharp)) rmSync(legacySharp, { recursive: true, force: true });
  try {
    const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
    const ptyRoot = join(packageDir, 'node_modules', 'node-pty');
    stageNodePty({ dest: ptyRoot, platform, arch: process.arch });
    chmodSpawnHelpers(ptyRoot, platform, process.arch);
  } catch (error) {
    console.log(
      `Warning: node-pty staging skipped (${error instanceof Error ? error.message : String(error)}). PTY 工具将不可用。`,
    );
  }

  // 额外安装别名命令（如 studio）。与主命令共享同一个 packageDir / node-pty 运行时；
  // dist 下不存在对应二进制时跳过（例如只构建了主命令）。
  const aliases = (process.env.MICA_BUILD_ALIASES ?? 'studio')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  for (const alias of aliases) {
    const aliasFile = join(dirname(outFile), alias);
    if (existsSync(aliasFile)) {
      installBinary(alias, aliasFile);
    } else {
      console.log(`Skipped alias "${alias}": ${aliasFile} 不存在。`);
    }
  }
  console.log(`node-pty runtime: ${join(packageDir, 'node_modules', 'node-pty')}`);

  if (process.env.MICA_NO_RC !== '1') {
    const rcFiles = [join(home, '.zshrc'), join(home, '.bashrc'), join(home, '.bash_profile'), join(home, '.profile')];
    const rcFile = rcFiles.find((file) => existsSync(file));
    if (!rcFile) {
      console.log(`Warning: could not find shell rc file to add ${binDir} to PATH.`);
      process.exit(0);
    }

    const pathLine = `export PATH="${binDir}:$PATH"`;
    const content = readFileSync(rcFile, 'utf-8');
    if (content.includes(binDir)) {
      console.log(`${binDir} is already in PATH (${rcFile}).`);
    } else {
      appendFileSync(rcFile, `\n${pathLine}\n`);
      console.log(`Added ${binDir} to PATH in ${rcFile}.`);
      console.log(`Run \`source ${rcFile}\` or open a new terminal to apply.`);
    }
  }
} catch (error) {
  console.log(`Warning: install skipped (${error instanceof Error ? error.message : String(error)}).`);
  console.log(`You can copy ${outFile} to ${binDir} manually, or set MICA_INSTALL_DIR to a writable directory.`);
}

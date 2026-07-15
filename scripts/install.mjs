import { execSync } from 'node:child_process';
import { appendFileSync, chmodSync, cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const outFile = process.env.MICA_BUILD_OUTFILE ?? join('dist', process.env.MICA_BUILD_NAME ?? 'mica');
if (!existsSync(outFile)) {
  execSync('bun scripts/build.mjs', { stdio: 'inherit' });
}

const home = homedir();
const binName = process.env.MICA_BIN_NAME ?? 'mica';
// Keep the binary and sharp runtime together. A thin launcher goes into PATH.
const packageDir = process.env.MICA_INSTALL_PACKAGE_DIR ?? resolve(home, '.local/lib/mica');
const binDir = process.env.MICA_INSTALL_DIR ?? resolve(home, '.local/bin');
const runtimeSource = process.env.MICA_SHARP_RUNTIME_DIR ?? join(dirname(outFile), 'sharp-runtime');

try {
  if (!existsSync(packageDir)) mkdirSync(packageDir, { recursive: true });
  if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });

  const packagedBinary = join(packageDir, binName);
  copyFileSync(outFile, packagedBinary);
  chmodSync(packagedBinary, 0o755);

  if (existsSync(runtimeSource)) {
    for (const name of ['package.json', 'node_modules']) {
      const source = join(runtimeSource, name);
      const target = join(packageDir, name);
      if (!existsSync(source)) continue;
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      cpSync(source, target, { recursive: true, dereference: true });
    }
    console.log(`Installed sharp runtime into ${packageDir}`);
  } else {
    console.log(`Warning: sharp runtime not found at ${runtimeSource}; image resize may be unavailable.`);
  }

  const launcher = join(binDir, binName);
  // Always exec the packaged binary by absolute path so Bun resolves external
  // sharp modules from packageDir, not from the PATH launcher location.
  writeFileSync(
    launcher,
    `#!/bin/sh\nexec "${packagedBinary}" "$@"\n`,
    { mode: 0o755 },
  );
  chmodSync(launcher, 0o755);
  console.log(`Installed launcher to: ${launcher}`);
  console.log(`Packaged binary: ${packagedBinary}`);

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
} catch (error) {
  console.log(`Warning: install skipped (${error instanceof Error ? error.message : String(error)}).`);
  console.log(`You can copy ${outFile} to ${binDir} manually, or set MICA_INSTALL_DIR to a writable directory.`);
}

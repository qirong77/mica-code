import { execSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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

  const packagedBinary = join(packageDir, binName);
  copyFileSync(outFile, packagedBinary);
  chmodSync(packagedBinary, 0o755);

  // Remove native image runtime files left by versions that depended on sharp.
  for (const legacyPath of [join(packageDir, 'node_modules'), join(packageDir, 'package.json')]) {
    if (existsSync(legacyPath)) rmSync(legacyPath, { recursive: true, force: true });
  }

  const launcher = join(binDir, binName);
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

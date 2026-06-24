import { execSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const outFile = process.env.MICA_BUILD_OUTFILE ?? join('dist', process.env.MICA_BUILD_NAME ?? 'mica-code');
if (!existsSync(outFile)) {
  execSync('bun scripts/build.mjs', { stdio: 'inherit' });
}

const installDir = process.env.MICA_INSTALL_DIR ?? resolve(homedir(), '.local/bin');
const binName = process.env.MICA_BIN_NAME ?? 'mica-code';

try {
  if (!existsSync(installDir)) mkdirSync(installDir, { recursive: true });

  const targetFile = join(installDir, binName);
  copyFileSync(outFile, targetFile);
  chmodSync(targetFile, 0o755);
  console.log(`Installed to: ${targetFile}`);

  const home = homedir();
  const rcFiles = [join(home, '.zshrc'), join(home, '.bashrc'), join(home, '.bash_profile'), join(home, '.profile')];

  const rcFile = rcFiles.find((file) => existsSync(file));
  if (!rcFile) {
    console.log(`Warning: could not find shell rc file to add ${installDir} to PATH.`);
    process.exit(0);
  }

  const pathLine = `export PATH="${installDir}:$PATH"`;
  const content = readFileSync(rcFile, 'utf-8');
  if (content.includes(installDir)) {
    console.log(`${installDir} is already in PATH (${rcFile}).`);
  } else {
    appendFileSync(rcFile, `\n${pathLine}\n`);
    console.log(`Added ${installDir} to PATH in ${rcFile}.`);
    console.log(`Run \`source ${rcFile}\` or open a new terminal to apply.`);
  }
} catch (error) {
  console.log(`Warning: install skipped (${error instanceof Error ? error.message : String(error)}).`);
  console.log(`You can copy ${outFile} to ${installDir} manually, or set MICA_INSTALL_DIR to a writable directory.`);
}

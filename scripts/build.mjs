import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const outDir = 'dist';
const outName = 'mica';

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const outFile = join(outDir, outName);
execSync(`bun build --compile ./src/index.ts --outfile ${outFile}`, {
  stdio: 'inherit',
});
console.log(`Built native binary: ${outFile}`);

const installDir = resolve(homedir(), '.local/bin');
if (!existsSync(installDir)) mkdirSync(installDir, { recursive: true });

const targetFile = join(installDir, outName);
copyFileSync(outFile, targetFile);
chmodSync(targetFile, 0o755);
console.log(`Installed to: ${targetFile}`);
console.log(`Make sure ${installDir} is in your PATH.`);

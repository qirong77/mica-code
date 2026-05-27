import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, chmodSync, appendFileSync, readFileSync } from 'node:fs';
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

const home = homedir();
const rcFiles = [
  join(home, '.zshrc'),
  join(home, '.bashrc'),
  join(home, '.bash_profile'),
  join(home, '.profile'),
];

const rcFile = rcFiles.find(f => existsSync(f));
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

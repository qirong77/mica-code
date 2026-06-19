import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const repositories = [
  { name: 'pi', url: 'https://github.com/earendil-works/pi.git' },
  { name: 'claude-code', url: 'https://github.com/claude-code-best/claude-code' },
  { name: 'codex', url: 'https://github.com/openai/codex' },
];

const tempDir = process.env.MICA_TEMP_DIR ?? './temp';

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    stdio: 'inherit',
    ...options,
  });
}

function output(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function isGitRepository(path) {
  return existsSync(join(path, '.git'));
}

function hasLocalChanges(path) {
  return output('git', ['status', '--porcelain'], { cwd: path }).length > 0;
}

function cloneRepository(repository) {
  console.log(`Cloning ${repository.name}...`);
  run('git', ['clone', repository.url, repository.name], { cwd: tempDir });
}

function updateRepository(repository, path) {
  if (!isGitRepository(path)) {
    console.log(`Skipping ${repository.name}: ${path} exists but is not a git repository.`);
    return;
  }

  if (hasLocalChanges(path)) {
    console.log(`Skipping ${repository.name}: repository has local changes.`);
    return;
  }

  console.log(`Updating ${repository.name}...`);
  run('git', ['fetch', '--prune'], { cwd: path });
  run('git', ['pull', '--ff-only'], { cwd: path });
}

if (!existsSync(tempDir)) {
  mkdirSync(tempDir, { recursive: true });
}

for (const repository of repositories) {
  const repositoryPath = join(tempDir, repository.name);

  if (existsSync(repositoryPath)) {
    updateRepository(repository, repositoryPath);
  } else {
    cloneRepository(repository);
  }
}

console.log(`Temp repositories are ready in ${tempDir}.`);

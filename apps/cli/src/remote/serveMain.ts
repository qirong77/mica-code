#!/usr/bin/env bun
/**
 * Standalone worker entry for container / headless verification.
 *
 * `mica remote serve` is the product entry; this file keeps the same worker
 * without loading the interactive CLI, so a test machine can run it from a
 * single bundled file.
 */
import { startRemoteWorker } from './worker.js';

function values(argv: string[], name: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === name && argv[index + 1]) found.push(argv[index + 1]!);
    else if (arg.startsWith(`${name}=`)) found.push(arg.slice(name.length + 1));
  }
  return found;
}

function single(argv: string[], name: string): string | undefined {
  return values(argv, name).at(-1);
}

const argv = process.argv.slice(2);
const command = argv[0];
if (command !== 'serve') {
  console.error('usage: worker.js serve --relay <url> [--invite <code>] [--workspace <path>]...');
  process.exit(2);
}
const relay = single(argv, '--relay');
if (!relay) {
  console.error('missing --relay');
  process.exit(2);
}
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

const worker = await startRemoteWorker({
  relay,
  invite: single(argv, '--invite'),
  name: single(argv, '--name'),
  workspaces: values(argv, '--workspace'),
  ...(single(argv, '--state-dir') ? { stateDir: single(argv, '--state-dir')! } : {}),
  ...(single(argv, '--session-dir') ? { sessionDir: single(argv, '--session-dir')! } : {}),
  signal: controller.signal,
});

await new Promise<void>((resolve) => {
  if (controller.signal.aborted) resolve();
  else controller.signal.addEventListener('abort', () => resolve(), { once: true });
});
worker.stop();
process.stdout.write('worker stopped\n');

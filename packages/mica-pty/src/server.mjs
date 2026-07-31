#!/usr/bin/env node
// Node-side PTY helper server for the mica PTY tools.
//
// The mica host runs on Bun, where node-pty's native binding is inert (spawned
// PTY processes never deliver output). PTY sessions therefore live in this
// Node child process. Commands arrive as JSONL on stdin, events are written as
// JSONL on stdout, one JSON object per line.
//
// The resolved node-pty module entry is passed via the MICA_PTY_ENTRY
// environment variable (file:// URL or absolute path) so this script does not
// need a node_modules lookup of its own.

import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ptyEntryArg = process.env.MICA_PTY_ENTRY;
const ptyEntry = ptyEntryArg && ptyEntryArg.startsWith('file://') ? fileURLToPath(ptyEntryArg) : ptyEntryArg;
const pty = ptyEntry ? require(ptyEntry) : null;

const sessions = new Map();

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function reply(id, obj) {
  emit({ id, ...obj });
}

function createSessionId() {
  return randomBytes(6).toString('hex');
}

function handleSpawn(id, msg) {
  try {
    if (!pty) throw new Error('node-pty 加载失败：缺少 MICA_PTY_ENTRY');
    const argv = Array.isArray(msg.argv) ? msg.argv : [];
    if (argv.length === 0) throw new Error('spawn 需要非空 argv');
    const [file, ...args] = argv;
    const options = msg.options ?? {};
    const proc = pty.spawn(file, args, {
      name: options.name ?? 'xterm-256color',
      cols: options.cols ?? 120,
      rows: options.rows ?? 40,
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
    });
    const sessionId = createSessionId();
    sessions.set(sessionId, { proc });
    proc.onData((data) => emit({ type: 'data', session: sessionId, data }));
    proc.onExit((info) => {
      emit({ type: 'exit', session: sessionId, exitCode: info.exitCode, signal: info.signal });
      sessions.delete(sessionId);
    });
    reply(id, { ok: true, session: sessionId, pid: proc.pid });
  } catch (error) {
    reply(id, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function handleSend(id, msg) {
  const entry = sessions.get(msg.session);
  if (!entry) return reply(id, { ok: false, error: `session 不存在: ${msg.session}` });
  try {
    entry.proc.write(msg.data ?? '');
    reply(id, { ok: true });
  } catch (error) {
    reply(id, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function handleResize(id, msg) {
  const entry = sessions.get(msg.session);
  if (!entry) return reply(id, { ok: false, error: `session 不存在: ${msg.session}` });
  try {
    entry.proc.resize(msg.cols ?? 120, msg.rows ?? 40);
    reply(id, { ok: true });
  } catch (error) {
    reply(id, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function handleClose(id, msg) {
  const entry = sessions.get(msg.session);
  if (!entry) return reply(id, { ok: true, alreadyGone: true });
  try {
    entry.proc.kill(msg.signal ?? 'SIGTERM');
  } catch {
    // Already gone.
  }
  const forceAfterMs = msg.forceAfterMs ?? 3000;
  const timer = setTimeout(() => {
    try {
      entry.proc.kill('SIGKILL');
    } catch {
      // Ignore.
    }
  }, forceAfterMs);
  timer.unref?.();
  reply(id, { ok: true });
}

function handleList(id) {
  reply(id, { ok: true, sessions: [...sessions.keys()] });
}

function handleShutdown() {
  for (const entry of sessions.values()) {
    try {
      entry.proc.kill('SIGKILL');
    } catch {
      // Ignore.
    }
  }
  sessions.clear();
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  try {
    switch (msg.type) {
      case 'spawn':
        handleSpawn(msg.id, msg);
        break;
      case 'send':
        handleSend(msg.id, msg);
        break;
      case 'resize':
        handleResize(msg.id, msg);
        break;
      case 'close':
        handleClose(msg.id, msg);
        break;
      case 'list':
        handleList(msg.id);
        break;
      case 'shutdown':
        handleShutdown();
        break;
      default:
        reply(msg.id, { ok: false, error: `unknown command: ${msg.type}` });
    }
  } catch (error) {
    reply(msg.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
rl.on('close', () => handleShutdown());

// If stdin never opens (e.g. spawn failed), do not leave the process hanging.
setTimeout(() => {
  if (!rl.closed && process.stdin.destroyed) handleShutdown();
}, 5000).unref?.();

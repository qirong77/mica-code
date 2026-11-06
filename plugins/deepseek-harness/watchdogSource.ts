export const WATCHDOG_SOURCE = String.raw`import { spawn } from 'node:child_process';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const executable = process.env.MICA_DEEPSEEK_EXECUTABLE;
const dataDir = process.env.MICA_DEEPSEEK_DATA_DIR;
const parentPid = Number(process.env.MICA_DEEPSEEK_PARENT_PID);
const port = Number(process.env.MICA_DEEPSEEK_PORT || 0);
const statusPath = join(dataDir, 'data.json');
let child;
let stopping = false;
let output = '';

function writeStatus(status) {
  const target = statusPath + '.tmp-' + process.pid;
  writeFileSync(target, JSON.stringify(status) + '\n', { mode: 0o600 });
  renameSync(target, statusPath);
}

function status(state, tone, extra = {}) {
  writeStatus({
    state: { text: state, tone },
    process: { text: 'DeepSeek Harness watchdog ' + process.pid, tone },
    executable,
    ...extra,
  });
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function stopChild() {
  if (!child || child.killed) return;
  try {
    child.kill('SIGTERM');
  } catch {}
}

function finish(code, state, tone) {
  if (stopping) return;
  stopping = true;
  stopChild();
  try {
    status(state, tone);
  } catch {}
  setTimeout(() => process.exit(code), 25).unref();
}

if (!executable || !dataDir || !existsSync(executable) || !alive(parentPid)) {
  finish(1, '未启动', 'warn');
} else {
  status('启动中', 'warn');
  try {
    child = spawn(executable, ['web', '--no-open', '--host', '127.0.0.1', '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env,
    });
  } catch (error) {
    status('启动失败', 'error');
    process.exitCode = 1;
  }
  if (child) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output = (output + String(chunk)).slice(-16384);
      const match = output.match(/dsh web:\s+(https?:\/\/[^\s]+)/);
      if (!match) return;
      try {
        const address = new URL(match[1]).toString();
        status('运行中', 'ok', { address });
      } catch {}
    });
    child.on('error', () => finish(1, '启动失败', 'error'));
    child.on('exit', (code) => {
      if (!stopping) {
        stopping = true;
        try {
          status(code === 0 ? '已停止' : '进程退出', code === 0 ? 'warn' : 'error');
        } catch {}
        process.exitCode = code === 0 ? 0 : 1;
      }
    });
  }
}

function checkParent() {
  if (!stopping && !alive(parentPid)) finish(0, '父会话已退出', 'warn');
  if (!stopping) setTimeout(checkParent, 1000).unref();
}
checkParent();
process.on('SIGTERM', () => finish(0, '已停止', 'warn'));
process.on('SIGINT', () => finish(0, '已停止', 'warn'));
`;

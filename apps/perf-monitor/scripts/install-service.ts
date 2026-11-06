import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('LaunchAgent 安装只支持 macOS；其他平台使用 bun run start。');
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!(await Bun.file(join(app, 'dist/index.html')).exists())) throw new Error('先运行 npm run build，再安装监控服务。');
const label = 'com.qirong.mica-perf-web';
const logs = join(homedir(), 'Library/Logs/mica-perf-monitor');
const agents = join(homedir(), 'Library/LaunchAgents');
await mkdir(logs, { recursive: true });
await mkdir(agents, { recursive: true });
for (const name of ['runtime.log', 'error.log']) {
  const path = join(logs, name);
  const st = await stat(path).catch(() => null);
  if (st && st.size > 5 * 1024 * 1024) await rename(path, `${path}.1`);
}
const xml = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const plist = join(agents, `${label}.plist`);
await writeFile(
  plist,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(app, 'server/index.ts'))}</string></array>
<key>WorkingDirectory</key><string>${xml(app)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ProcessType</key><string>Background</string><key>Nice</key><integer>10</integer>
<key>LowPriorityIO</key><true/>
<key>StandardOutPath</key><string>${xml(join(logs, 'runtime.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(logs, 'error.log'))}</string>
</dict></plist>
`,
  { mode: 0o600 },
);
const uid = process.getuid!();
const old = Bun.spawn(['/bin/launchctl', 'bootout', `gui/${uid}/${label}`], { stdout: 'ignore', stderr: 'ignore' });
await old.exited;
const install = Bun.spawn(['/bin/launchctl', 'bootstrap', `gui/${uid}`, plist], {
  stdout: 'inherit',
  stderr: 'inherit',
});
if ((await install.exited) !== 0) throw new Error('启动失败，请检查 launchctl 与 9316 端口。');
console.log('监控服务已安装，登录后自动启动：http://127.0.0.1:9316');
console.log(`移除：launchctl bootout gui/${uid}/${label}，然后删除 ${plist}`);

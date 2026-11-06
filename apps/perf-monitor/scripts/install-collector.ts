import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.platform !== 'darwin') throw new Error('资源采集器只支持 macOS');
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tools = join(homedir(), '.mica/tools');
const destination = join(tools, 'mica-resource-watch.py');
const source = join(app, 'collectors/mica-resource-watch.py');
await mkdir(tools, { recursive: true });
const old = await readFile(destination).catch(() => null);
const next = await readFile(source);
if (old && !old.equals(next)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await copyFile(destination, `${destination}.backup-${stamp}`);
}
await copyFile(source, destination);
const logs = join(homedir(), 'Library/Logs/cpu-watch');
await mkdir(logs, { recursive: true });
const agents = join(homedir(), 'Library/LaunchAgents');
await mkdir(agents, { recursive: true });
const label = 'com.qirong.mica-resource-watch';
const plist = join(agents, `${label}.plist`);
const xml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
await writeFile(
  plist,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>/usr/bin/python3</string><string>${xml(destination)}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ProcessType</key><string>Background</string><key>LowPriorityIO</key><true/>
<key>Nice</key><integer>10</integer><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(join(logs, 'resource-watch.err.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(logs, 'resource-watch.err.log'))}</string>
</dict></plist>
`,
  { mode: 0o600 },
);
const target = `gui/${process.getuid!()}`;
await Bun.spawn(['/bin/launchctl', 'bootout', `${target}/${label}`], { stdout: 'ignore', stderr: 'ignore' }).exited;
if (
  (await Bun.spawn(['/bin/launchctl', 'bootstrap', target, plist], { stdout: 'inherit', stderr: 'inherit' }).exited) !==
  0
)
  throw new Error('采集器启动失败');
console.log('资源采集器 V2 已安装：修正 Mach CPU 时间、使用 rusage V4、新增可读取进程的 I/O。');

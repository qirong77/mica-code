/**
 * 一键把 relay 部署到中转机，并把本地插件设置写好。
 *
 *   node setup.mjs --host root@1.2.3.4
 *
 * 默认走 SSH：中转机不需要对外暴露任何管理接口（早先那版要求一个 HTTP shell 端点，
 * 那等于把整台机器交出去）。域名不给就按公网 IP 推出 `<ip>.sslip.io`，证书由 certbot
 * 自动签发——自签证书会让手机浏览器直接白屏，所以不做那条路。
 *
 * 部署完成后会直接写 `$MICA_HOME/plugin-settings/mobile-relay.json`，用户不用再抄口令。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? String(args[index + 1] ?? '') : fallback;
};
const has = (name) => args.includes(`--${name}`);

const target = flag('host', process.env.RELAY_SSH || '');
const port = flag('port', '9200');
const token = flag('token', process.env.RELAY_TOKEN || randomBytes(18).toString('hex'));
const skipCert = has('no-cert');
const dryRun = has('dry-run');
const remoteDir = '/opt/mobile-relay';
const here = import.meta.dirname;

if (!target) {
  console.error('用法：node setup.mjs --host root@1.2.3.4 [--domain 1-2-3-4.sslip.io] [--port 9200] [--no-cert]');
  process.exit(1);
}

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

/** SSH 执行；`input` 走 stdin（用来传 tar 包）。 */
function ssh(command, { input, timeout = 120_000 } = {}) {
  return execFileSync('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=8',
    '-o', 'ServerAliveInterval=10',
    target,
    command,
  ], {
    input,
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    encoding: input ? undefined : 'utf8',
  });
}

function step(label) {
  process.stdout.write(`\n▸ ${label}\n`);
}

let publicIp = '';
if (!dryRun) {
  step('检查 SSH 连通性');
  try {
    ssh('echo ok');
  } catch {
    fail(`连不上 ${target}。先确认 ssh ${target} 可以直接登录（本机已配好免密密钥）。`);
  }

  step('探测中转机环境');
  const probe = ssh(`
    set -e
    command -v node >/dev/null && node -v || echo NO_NODE
    command -v nginx >/dev/null && echo NGINX || echo NO_NGINX
    command -v certbot >/dev/null && echo CERTBOT || echo NO_CERTBOT
    ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \\K[\\d.]+' | head -1 || hostname -I | awk '{print $1}'
  `);
  const lines = String(probe).trim().split('\n').map((line) => line.trim());
  const nodeVersion = lines[0]?.startsWith('v') ? lines[0] : '';
  const hasNginx = lines.includes('NGINX');
  const hasCertbot = lines.includes('CERTBOT');
  publicIp = lines.find((line) => /^\d+\.\d+\.\d+\.\d+$/.test(line)) || '';

  if (!nodeVersion) fail('中转机没有 node（需要 18+）：apt install -y nodejs');
  if (!hasNginx) fail('中转机没有 nginx：apt install -y nginx');
  if (!skipCert && !hasCertbot) fail('中转机没有 certbot：apt install -y certbot python3-certbot-nginx（或用 --no-cert 跳过）');

  const major = Number(nodeVersion.slice(1).split('.')[0]);
  if (major < 18) fail(`中转机 node 版本过低（${nodeVersion}），需要 18+`);
  process.stdout.write(`  node ${nodeVersion}\n`);
}

const domain = flag('domain', publicIp ? `${publicIp.replaceAll('.', '-')}.sslip.io` : 'PRETEND.sslip.io');
if (!domain) fail('无法推断公网 IP，请用 --domain 指定域名');

step('打包并上传（relay + 页面产物）');
const rendererDir = join(here, '..', '..', 'apps', 'desktop', 'out', 'renderer');
if (!existsSync(rendererDir)) {
  fail(`找不到页面产物 ${rendererDir}\n  先在仓库根跑：cd apps/desktop && npm run build:server`);
}
const work = mkdtempSync(join(tmpdir(), 'mica-relay-setup-'));
try {
  const bundle = join(work, 'bundle');
  mkdirSync(join(bundle, 'public'), { recursive: true });
  writeFileSync(join(bundle, 'relay.mjs'), readFileSync(join(here, 'relay', 'relay.mjs')));
  writeFileSync(join(bundle, 'mobile-relay.service'), readFileSync(join(here, 'relay', 'mobile-relay.service')));
  writeFileSync(
    join(bundle, 'relay.env'),
    [
      `RELAY_PORT=${port}`,
      `RELAY_TOKEN=${token}`,
      'RELAY_BIND=127.0.0.1',
      '',
    ].join('\n'),
  );
  execFileSync('cp', ['-R', `${rendererDir}/.`, join(bundle, 'public')], { timeout: 120_000 });
  const tarball = join(work, 'bundle.tgz');
  execFileSync('tar', ['-czf', tarball, '-C', bundle, '.'], { timeout: 180_000 });
  const size = readFileSync(tarball).length;
  process.stdout.write(`  ${(size / 1024 / 1024).toFixed(1)}MB\n`);

  if (!dryRun) {
    ssh(`mkdir -p ${remoteDir} && rm -rf ${remoteDir}/public`, { timeout: 60_000 });
    ssh(`tar -xzf - -C ${remoteDir}`, { input: readFileSync(tarball), timeout: 300_000 });
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (dryRun) {
  process.stdout.write(`\n✓ 预演结束，没有向 ${target} 写任何东西。\n`);
  process.stdout.write(`  将要部署：domain=${domain} port=${port} token=${token}\n`);
  process.exit(0);
}

step('安装 systemd 服务');
ssh(
  [
    `chown -R www-data:www-data ${remoteDir}`,
    `chmod 600 ${remoteDir}/relay.env`,
    `cp ${remoteDir}/mobile-relay.service /etc/systemd/system/mobile-relay.service`,
    'systemctl daemon-reload',
    'systemctl enable mobile-relay >/dev/null 2>&1 || true',
    'systemctl restart mobile-relay',
    'sleep 2',
    'systemctl is-active mobile-relay',
  ].join(' && '),
);

step('配置 nginx');
const site = readFileSync(join(here, 'relay', 'nginx-site.conf'), 'utf8')
  .replaceAll('__DOMAIN__', domain)
  .replaceAll('__PORT__', port);
ssh(`cat > /etc/nginx/sites-available/mobile-relay <<'MICA_EOF'\n${site}MICA_EOF`);
ssh(
  [
    'ln -sf /etc/nginx/sites-available/mobile-relay /etc/nginx/sites-enabled/mobile-relay',
    'nginx -t',
    'systemctl reload nginx',
  ].join(' && '),
);

if (!skipCert) {
  step('申请证书（Let\'s Encrypt）');
  ssh(`certbot --nginx -d ${domain} --non-interactive --agree-tos --register-unsafely-without-email --redirect`, {
    timeout: 300_000,
  });
}

step('验证');
const base = skipCert ? `http://${domain}` : `https://${domain}`;
let healthy = false;
for (let attempt = 0; attempt < 8; attempt += 1) {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(8_000) });
    if (res.ok) {
      const info = await res.json();
      healthy = true;
      process.stdout.write(`  中转机可达，agentOnline=${info.agentOnline}\n`);
      break;
    }
  } catch {
    // 证书刚签发，等一会儿再试
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
if (!healthy) {
  process.stdout.write(`  暂未通过 ${base}/api/health 校验，稍后重试\n`);
}

step('写入本地插件设置');
const home = process.env.MICA_HOME || join(homedir(), '.mica');
const settingsDir = join(home, 'plugin-settings');
const settingsPath = join(settingsDir, 'mobile-relay.json');
mkdirSync(settingsDir, { recursive: true });
const existing = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
writeFileSync(
  settingsPath,
  `${JSON.stringify({ ...existing, enabled: 'true', relayUrl: base, token }, null, 2)}\n`,
);

console.log(`
✓ 完成

  手机打开： ${base}/?t=${token}
  插件设置： ${settingsPath}

  启停桥进程：配置页 → 插件 → Mobile Relay 的「启用桥」，或改上面那个文件。
`);

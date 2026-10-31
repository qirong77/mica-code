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
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? String(args[index + 1] ?? '') : fallback;
};
const has = (name) => args.includes(`--${name}`);

const target = flag('host', process.env.RELAY_SSH || '');
let port = flag('port', '9200');
/** 不少机器把 SSH 挪到非标准端口（22 直接超时），别让它成为部署的绊脚石。 */
const sshPort = flag('ssh-port', process.env.RELAY_SSH_PORT || '22');
/** 显式给口令才用它；否则先看本机已有设置、再看中转机上有没有同名机器。 */
const forcedToken = flag('token', process.env.RELAY_TOKEN || '');
const label = flag('label', hostname());
const skipCert = has('no-cert');
const dryRun = has('dry-run');
const remoteDir = '/opt/mobile-relay';
const stateDir = '/var/lib/mobile-relay';
const agentsFile = `${stateDir}/agents.json`;
const here = import.meta.dirname;

if (!target) {
  console.error(
    '用法：node setup.mjs --host root@1.2.3.4 [--ssh-port 22] [--domain 1-2-3-4.sslip.io] [--port 9200] [--label 机器名] [--no-cert]',
  );
  process.exit(1);
}

/** 和中转机同一套：口令派生出的路由标识。 */
const agentIdOf = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12);

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
    '-p', sshPort,
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

/**
 * 找到桌面端的 renderer 产物。
 *
 * 中转机托管的就是这一份页面，而它只能从仓库构建出来。**不要**去读已安装应用里的产物：
 * 打包后在 `app.asar` 里，只有 Electron 自己读得到，硬抠出来是 hack，还会随版本漂移。
 * 所以只认「仓库里的构建产物」与显式指定的目录，缺了就明确告诉人去构建。
 */
function resolveRendererDir() {
  const looksLikeRenderer = (dir) => Boolean(dir) && existsSync(join(dir, 'index.html'));
  const explicit = flag('renderer', process.env.MICA_DESKTOP_RENDERER || '');
  if (explicit) {
    if (!looksLikeRenderer(explicit)) fail(`--renderer 指向的目录里没有 index.html：${explicit}`);
    return explicit;
  }

  const candidates = [
    join(here, '..', '..', 'apps', 'desktop', 'out', 'renderer'),
    join(process.cwd(), 'apps', 'desktop', 'out', 'renderer'),
  ];
  for (const dir of candidates) {
    if (looksLikeRenderer(dir)) return dir;
  }

  fail(
    [
      '找不到页面产物（renderer）。中转机托管的那份页面必须从仓库构建：',
      '  cd apps/desktop && npm install && npx electron-vite build',
      '  或用 --renderer 指向另一台已构建机器上的 out/renderer。',
      `  已查找：${candidates.join('、')}`,
    ].join('\n'),
  );
}

let publicIp = '';
if (!dryRun) {
  step('检查 SSH 连通性');
  try {
    ssh('echo ok');
  } catch {
    fail(
      `连不上 ${target}（端口 ${sshPort}）。先确认 ssh -p ${sshPort} ${target} 可以直接登录（本机已配好免密密钥）。`,
    );
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

/**
 * 这台中转机是否已经部署过。
 *
 * 已经部署过就只「登记这台机器」：另一台电脑接入不该重传页面、重配 nginx、重签证书——
 * 那些步骤与它无关，还会把已经连着的手机打断一次。用 --redeploy 强制完整部署。
 */
const alreadyDeployed =
  !dryRun &&
  !has('redeploy') &&
  String(ssh('test -f /opt/mobile-relay/relay.mjs && systemctl is-active --quiet mobile-relay && echo YES || echo NO') || '').includes('YES');
const joinMode = alreadyDeployed;

/** 已部署时沿用中转机现有的域名与端口，别按公网 IP 推一个新的出来。 */
const existingSite = joinMode
  ? String(ssh("grep -m1 -oP 'server_name\\s+\\K[^;]+' /etc/nginx/sites-available/mobile-relay 2>/dev/null || true") || '').trim()
  : '';
const existingPort = joinMode
  ? String(ssh("grep -m1 -oP '^RELAY_PORT=\\K[0-9]+' /opt/mobile-relay/relay.env 2>/dev/null || true") || '').trim()
  : '';
if (joinMode && existingPort) port = existingPort;

if (joinMode) {
  process.stdout.write(`  中转机已部署（${existingSite || '未知域名'}），只登记这台机器\n`);
}

const domain = flag(
  'domain',
  existingSite || (publicIp ? `${publicIp.replaceAll('.', '-')}.sslip.io` : ''),
);
if (!domain) fail('无法推断公网 IP，请用 --domain 指定域名');

step('核对这台机器在中转机上的登记');
const home = process.env.MICA_HOME || join(homedir(), '.mica');
const settingsDir = join(home, 'plugin-settings');
const settingsPath = join(settingsDir, 'mobile-relay.json');
let localSettings = {};
try {
  localSettings = JSON.parse(readFileSync(settingsPath, 'utf8'));
} catch {
  // 还没配过，按新机器处理
}

/** 中转机上已登记的机器；首次部署时为空。 */
let knownAgents = [];
let relayConfiguration = {};
try {
  const raw = String(ssh(`cat ${agentsFile} 2>/dev/null || true`) || '').trim();
  const parsed = raw ? JSON.parse(raw) : { agents: [] };
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) relayConfiguration = parsed;
  knownAgents = Array.isArray(parsed?.agents) ? parsed.agents : [];
} catch {
  knownAgents = [];
}

/**
 * 口令复用：只有「本机设置已经指向这台中转机、且它的口令还在清单里」才算同一台机器。
 * 这样重跑 setup 不会把已经连着的手机关在外面，也不会挤掉别的机器。
 */
const sameRelay = String(localSettings?.relayUrl || '').includes(domain);
/** 同一台机器换域名重跑时，按名字认领回原来的口令，别在中转机上留一条重复记录。 */
const sameLabel = knownAgents.find((agent) => agent?.label === label);
const reusable =
  (sameLabel && typeof sameLabel.token === 'string' && sameLabel.token.length >= 16 ? sameLabel.token : '') ||
  (typeof localSettings?.token === 'string' &&
  localSettings.token.length >= 16 &&
  sameRelay &&
  knownAgents.some((agent) => agent?.token === localSettings.token)
    ? localSettings.token
    : '');
const token = forcedToken || reusable || randomBytes(18).toString('hex');
const previous = knownAgents.find((agent) => agent?.token === token);
process.stdout.write(
  `  ${previous ? '复用已有口令' : '登记为新机器'}（中转机上现有 ${knownAgents.length} 台）\n`,
);

const agentsPayload = {
  ...relayConfiguration,
  version: 1,
  agents: [
    ...knownAgents.filter((agent) => agent?.token !== token),
    {
      ...previous,
      id: agentIdOf(token),
      label,
      token,
      createdAt: Number(previous?.createdAt) || Date.now(),
    },
  ],
};

if (!joinMode) {
step('打包并上传（relay + 页面产物）');
const rendererDir = resolveRendererDir();
process.stdout.write(`  页面产物 ${rendererDir}\n`);
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
      'RELAY_BIND=127.0.0.1',
      `RELAY_STATE_DIR=${stateDir}`,
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
}

if (dryRun) {
  process.stdout.write(`\n✓ 预演结束，没有向 ${target} 写任何东西。\n`);
  process.stdout.write(`  将要部署：domain=${domain} port=${port} label=${label} token=${token}\n`);
  process.stdout.write(`  将登记 ${agentsPayload.agents.length} 台机器\n`);
  process.exit(0);
}

step('登记到中转机的机器清单');
// heredoc 的终止符必须独占一行，所以这段单独发一次，别和后面的命令用 && 串起来。
ssh(`mkdir -p ${stateDir}`);
ssh(`cat > ${agentsFile} <<'MICA_AGENTS'\n${JSON.stringify(agentsPayload, null, 2)}\nMICA_AGENTS`);
ssh(
  [
    `chown -R www-data:www-data ${stateDir}`,
    `chmod 600 ${agentsFile}`,
  ].join(' && '),
);

if (!joinMode) {
step('安装 systemd 服务');
try {
  ssh(
  [
    `chown -R www-data:www-data ${remoteDir}`,
    `chmod 600 ${remoteDir}/relay.env`,
    `cp ${remoteDir}/mobile-relay.service /etc/systemd/system/mobile-relay.service`,
    'systemctl daemon-reload',
    'systemctl enable mobile-relay >/dev/null 2>&1 || true',
    'systemctl restart mobile-relay',
    // 服务可能先经历一次 activating，等它稳定下来再判定，别把正常启动当成失败。
    'for i in $(seq 1 20); do systemctl is-active --quiet mobile-relay && break; sleep 1; done',
    'systemctl is-active mobile-relay',
  ].join(' && '),
  );
} catch {
  // 起不来时把日志带上来，否则只剩一句 is-active（exit 3），看不出原因。
  const why = String(ssh('journalctl -u mobile-relay -n 15 --no-pager | tail -10 || true') || '');
  fail(`中转机上的 mobile-relay 没启动：\n${why}`);
}
}

if (!joinMode) {
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
}

if (!joinMode && !skipCert) {
  step('申请证书（Let\'s Encrypt）');
  ssh(`certbot --nginx -d ${domain} --non-interactive --agree-tos --register-unsafely-without-email --redirect`, {
    timeout: 300_000,
  });
}

// certbot 自己写的 443 server 块默认只说 HTTP/1.1；手机首屏要并发拉十几个资源，
// 换成 HTTP/2 能省掉串行往返。已经在就别重复插。
ssh(`grep -q "http2 on;" /etc/nginx/sites-available/mobile-relay || ` +
  `sed -i '/listen 443 ssl/ a\\    http2 on;' /etc/nginx/sites-available/mobile-relay; ` +
  `nginx -t && systemctl reload nginx`);

step('验证');
const base = skipCert ? `http://${domain}` : `https://${domain}`;
let healthy = false;
for (let attempt = 0; attempt < 8; attempt += 1) {
  try {
    const res = await fetch(`${base}/api/health?t=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      const info = await res.json();
      // join 模式下这台刚写进清单，中转机最多 5 秒后热加载；没加载出来就继续等，
      // 否则会显示 agentOnline=undefined 让用户以为没接上。
      if (!joinMode || info.label) {
        healthy = true;
        process.stdout.write(`  中转机可达，agentOnline=${info.agentOnline}\n`);
        break;
      }
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
mkdirSync(settingsDir, { recursive: true });
writeFileSync(
  settingsPath,
  `${JSON.stringify({ ...localSettings, enabled: 'true', relayUrl: base, token }, null, 2)}\n`,
);

if (joinMode) {
  process.stdout.write('  桥会在插件下一跳（≤3 秒）自动按新设置连上\n');
}

const total = agentsPayload.agents.length;
console.log(`
✓ 完成（这台机器：${label}${total > 1 ? `，中转机上共 ${total} 台` : ''}）

  手机打开： ${base}/?t=${token}
  插件设置： ${settingsPath}

  启停桥进程：配置页 → 插件 → Mobile Relay 的「启用桥」，或改上面那个文件。
${
  total > 1
    ? `  手机打开过任一机器的链接后，再访问 ${base}/ 会让它选机器。\n`
    : ''
}`);

/**
 * 部署 relay 到中转机（走中转机自己的文件/命令接口，不需要 SSH）。
 *
 *   RELAY_ADMIN=http://1.2.3.4:9100 node deploy.mjs --port 9200 --token xxx
 *
 * 它只传 `relay/relay.mjs` 并重启服务；页面产物另用 `upload.mjs` 推。
 */
import { readFileSync } from 'node:fs'

const ADMIN = String(process.env.RELAY_ADMIN || '').replace(/\/+$/, '')
const args = process.argv.slice(2)
const port = argOf('--port', process.env.RELAY_PORT || '9200')
const token = argOf('--token', process.env.RELAY_TOKEN || '')
const host = argOf('--host', process.env.RELAY_PUBLIC_HOST || '')
const remoteDir = '/opt/mobile-relay'

if (!ADMIN) {
  console.error('需要 RELAY_ADMIN，例如 RELAY_ADMIN=http://1.2.3.4:9100')
  process.exit(1)
}
if (!token) {
  console.error('需要 --token（手机访问口令，同时是加密密钥的种子）')
  process.exit(1)
}

function argOf(flag, fallback) {
  const index = args.indexOf(flag)
  return index >= 0 ? String(args[index + 1] ?? '') : fallback
}

async function put(path, content) {
  const res = await fetch(`${ADMIN}/files`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content })
  })
  if (!res.ok) throw new Error(`upload ${path} HTTP ${res.status}`)
  const json = await res.json()
  if (!json.ok) throw new Error(`upload ${path}: ${JSON.stringify(json).slice(0, 200)}`)
}

async function sh(command, timeout = 60_000) {
  const res = await fetch(`${ADMIN}/shell/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, timeout: timeout - 5_000 })
  })
  const json = await res.json()
  const out = json?.data?.stdout ?? ''
  if (out) process.stdout.write(out)
  if (json?.data?.stderr) process.stderr.write(json.data.stderr)
  return json?.data?.exitCode ?? -1
}

const relay = readFileSync(new URL('./relay/relay.mjs', import.meta.url))
const service = readFileSync(new URL('./relay/mobile-relay.service', import.meta.url), 'utf8')

await sh(`mkdir -p ${remoteDir}`)
await put(`${remoteDir}/relay.mjs.b64`, relay.toString('base64'))
await put(`${remoteDir}/mobile-relay.service`, service)
await put(
  `${remoteDir}/relay.env`,
  [
    `RELAY_PORT=${port}`,
    `RELAY_TOKEN=${token}`,
    // 放在 nginx 后面：只绑回环，TLS 由 nginx 终结
    'RELAY_BIND=127.0.0.1',
    'RELAY_TLS=off',
    host ? `RELAY_HOST=${host}` : ''
  ]
    .filter(Boolean)
    .join('\n') + '\n'
)

const code = await sh(
  [
    'set -e',
    `base64 -d ${remoteDir}/relay.mjs.b64 > ${remoteDir}/relay.mjs`,
    `rm -f ${remoteDir}/relay.mjs.b64`,
    `chown -R www-data:www-data ${remoteDir}`,
    `chmod 600 ${remoteDir}/relay.env`,
    `cp ${remoteDir}/mobile-relay.service /etc/systemd/system/mobile-relay.service`,
    'systemctl daemon-reload',
    'systemctl enable mobile-relay >/dev/null 2>&1 || true',
    'systemctl restart mobile-relay',
    'sleep 2',
    'systemctl is-active mobile-relay',
    `ss -lntp | grep :${port} || true`
  ].join(' && '),
  120_000
)

console.log(code === 0 ? '部署完成' : `部署失败（exit ${code}）`)

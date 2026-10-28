/**
 * 把 relay 代码与 renderer 构建产物推到中转机。
 *
 * 只是一次性部署工具：按 480KB 分片 POST 到中转机的文件接口，再在远端拼回、
 * 解包、重启服务。日常更新产物时重跑即可。
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const HOST = process.env.RELAY_HOST || 'http://188.253.118.143:9100'
const CHUNK = 480_000
const REMOTE_DIR = '/opt/mobile-relay'

async function putFile(path, content) {
  const body = JSON.stringify({ path, content })
  const res = await fetch(`${HOST}/files`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body
  })
  if (!res.ok) throw new Error(`upload ${path} -> HTTP ${res.status}`)
  const json = await res.json()
  if (!json.ok) throw new Error(`upload ${path} failed: ${JSON.stringify(json).slice(0, 200)}`)
}

async function shell(command, timeout = 60_000) {
  const res = await fetch(`${HOST}/shell/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, timeout: timeout - 5000 })
  })
  const json = await res.json()
  const out = json?.data?.stdout ?? ''
  const err = json?.data?.stderr ?? ''
  if (out) process.stdout.write(out)
  if (err) process.stderr.write(err)
  return json?.data?.exitCode ?? -1
}

async function uploadChunked(remotePath, buffer) {
  const b64 = buffer.toString('base64')
  const pieces = []
  for (let off = 0; off < b64.length; off += CHUNK) pieces.push(b64.slice(off, off + CHUNK))
  console.log(`上传 ${remotePath}: ${(buffer.length / 1024 / 1024).toFixed(2)}MB → ${pieces.length} 片`)
  // 远端先清空，再逐片追加
  await putFile(`${remotePath}.b64`, pieces[0])
  for (let i = 1; i < pieces.length; i += 1) {
    await putFile(`${remotePath}.b64.part`, pieces[i])
    const code = await shell(
      `cat ${remotePath}.b64.part >> ${remotePath}.b64 && rm -f ${remotePath}.b64.part`,
      20_000
    )
    if (code !== 0) throw new Error(`append chunk ${i} failed`)
    if (i % 10 === 0) console.log(`  ${i}/${pieces.length}`)
  }
}

async function main() {
  const relay = readFileSync(new URL('./relay/relay.mjs', import.meta.url))
  const renderer = readFileSync(process.env.RENDERER_TGZ || '/tmp/renderer.tgz')

  await shell(`mkdir -p ${REMOTE_DIR}/public`)
  await uploadChunked(`${REMOTE_DIR}/relay.mjs`, relay)
  await uploadChunked(`${REMOTE_DIR}/renderer.tgz`, renderer)

  console.log('远端解包…')
  await shell(
    [
      `base64 -d ${REMOTE_DIR}/relay.mjs.b64 > ${REMOTE_DIR}/relay.mjs`,
      `base64 -d ${REMOTE_DIR}/renderer.tgz.b64 > ${REMOTE_DIR}/renderer.tgz`,
      `rm -rf ${REMOTE_DIR}/public && mkdir -p ${REMOTE_DIR}/public`,
      `tar -xzf ${REMOTE_DIR}/renderer.tgz -C ${REMOTE_DIR}/public`,
      `rm -f ${REMOTE_DIR}/relay.mjs.b64 ${REMOTE_DIR}/renderer.tgz ${REMOTE_DIR}/renderer.tgz.b64`,
      `systemctl restart mobile-relay`,
      `sleep 1 && systemctl is-active mobile-relay`,
      `du -sh ${REMOTE_DIR}/public`
    ].join(' && '),
    120_000
  )
}

void main()

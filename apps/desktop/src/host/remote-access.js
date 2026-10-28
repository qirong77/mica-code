/**
 * 远程访问口令的宿主：磁盘上的 `$MICA_HOME/remote-access.json`。
 *
 * 对外的读写入口只有插件能力面那一组（`plugin-host:access-get|set`，见 plugin-host.js）：
 * 「别的机器怎么进这台机器」既属于运行时、也需要在界面里解释，走同一条通道就不会出现
 * 卡片显示一套、请求分派按另一套走的局面。
 *
 * `MICA_HOME` 而不是 `userData`：这条策略描述的是「这台机器上的运行时允许谁进来」，和
 * 会话 / 界面状态一样属于用户级配置，换一个外壳（`node out/server/index.mjs` 直接起）也该
 * 读到同一份。
 *
 * 文件里存明文口令。它是访问口令而不是用户密码：本机窗口会把它回显在 Connections 卡片里
 * （「别人该输什么」本来就要让用户看得见），忘记时也可以直接改文件。磁盘权限按 0600 写。
 */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveMicaHome } from '@packages/mica-config/index.js'
import { networkInterfaces } from 'node:os'
import {
  emptyRemoteAccessPolicy,
  normalizeRemoteAccessPassword,
  normalizeRemoteAccessPolicy,
  withGeneratedSecret
} from './remote-access-core.js'

/** 缓存：每次请求都会读策略，不能每次都碰磁盘；文件 mtime 变了才重读。 */
let cache = null
let cacheStamp = { file: '', mtimeMs: -1, size: -1 }

function micaHome() {
  return process.env.MICA_HOME || resolveMicaHome()
}

export function remoteAccessFile() {
  return join(micaHome(), 'remote-access.json')
}

/**
 * 读策略。文件不存在、读不出来、内容坏掉，一律回到默认（不启用 + 默认口令）。
 *
 * `secret` 一定会被补齐并落盘：分享链接的凭据也由它派生，而分享在口令关闭时照常可用
 * （默认状态）。少了 secret 就只有拼出空令牌，分享页里的接口调用会全部失败。
 */
export function readRemoteAccessPolicy() {
  const file = remoteAccessFile()
  let stat = null
  try {
    stat = statSync(file)
  } catch {
    cache = ensureSecret(emptyRemoteAccessPolicy())
    cacheStamp = stampOf(file)
    return cache
  }
  if (
    cache &&
    cacheStamp.file === file &&
    cacheStamp.mtimeMs === stat.mtimeMs &&
    cacheStamp.size === stat.size
  ) {
    return cache
  }
  let raw = null
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    raw = null
  }
  cache = ensureSecret(normalizeRemoteAccessPolicy(raw))
  cacheStamp = stampOf(file)
  return cache
}

function stampOf(file) {
  try {
    const stat = statSync(file)
    return { file, mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return { file, mtimeMs: -1, size: -1 }
  }
}

/** 老文件、手改丢掉的 secret：补一个并写回（写不了盘就只活这次进程）。 */
function ensureSecret(policy) {
  if (policy.secret) return policy
  try {
    return writeRemoteAccessPolicy(policy)
  } catch {
    return withGeneratedSecret(policy)
  }
}

/**
 * 写回整份策略（先写临时文件再 rename：请求线程随时在读，不能让它读到半份 JSON）。
 * 口令必须是合法值，否则整次写入被拒——不合法就写进去会让「开关打开但没有口令」成为可能。
 */
export function writeRemoteAccessPolicy(next) {
  const normalized = withGeneratedSecret(normalizeRemoteAccessPolicy(next))
  const file = remoteAccessFile()
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    renameSync(temp, file)
    try {
      chmodSync(file, 0o600)
    } catch {
      // 某些文件系统（挂载的镜像）不支持改权限，写成功就算成功
    }
  } catch (error) {
    rmSync(temp, { force: true })
    throw new Error(`写入远程访问策略失败：${error?.message ?? error}`)
  }
  cacheStamp = { file: '', mtimeMs: -1, size: -1 }
  cache = null
  return normalized
}

/**
 * 其它机器能连到的地址（局域网 IPv4 + 运行时端口）。
 *
 * 卡片要告诉用户「别人打开哪个地址才会看到登录页」，`location.origin` 在这里没用——
 * 本机窗口的 origin 是 127.0.0.1，那是别人连不上的地址。
 */
function reachableAddresses(port) {
  const listenPort = Number(port) || 0
  if (!listenPort) return []
  const rows = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.internal || entry.family !== 'IPv4') continue
      rows.push(`http://${entry.address}:${listenPort}`)
    }
  }
  return rows.sort()
}

/** 运行时端口：由 server 启动（含端口回退）后告知，用来拼「别人能连到」的地址。 */
let runtimePort = 0

export function setRemoteAccessPort(port) {
  runtimePort = Number(port) || 0
}

/**
 * 给界面看的一份策略：开关、口令，以及别人打开哪个地址才会看到登录页。
 *
 * 口令原样回给页面——它要回答「别人该输什么」，而能调到这里的调用要么在本机、要么已经
 * 过了这道口令（远程未过门时 `/api/invoke` 会被 401）。磁盘路径一并给出：用户想直接改
 * 文件时知道改哪儿。
 */
export function describeRemoteAccess() {
  const policy = readRemoteAccessPolicy()
  return {
    enabled: policy.enabled,
    password: policy.password,
    addresses: reachableAddresses(runtimePort),
    path: remoteAccessFile()
  }
}

/** 只允许改开关与口令；secret 与 version 由宿主自己管。 */
export function applyRemoteAccessPatch(patch = {}) {
  const next = readRemoteAccessPolicy()
  if (typeof patch?.enabled === 'boolean') next.enabled = patch.enabled
  if (patch?.password !== undefined) {
    const password = normalizeRemoteAccessPassword(patch.password)
    if (!password) throw new Error('口令不能为空，且不能超过 64 个字符')
    next.password = password
  }
  return writeRemoteAccessPolicy(next)
}

export function resetRemoteAccessForTests() {
  cache = null
  cacheStamp = { file: '', mtimeMs: -1, size: -1 }
}

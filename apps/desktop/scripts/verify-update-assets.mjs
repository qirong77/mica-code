import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

// Build-time only: js-yaml is provided by electron-builder's development tree.
export async function verifyUpdateAssets(directory, { platform, version } = {}) {
  if (!['mac', 'linux', 'win'].includes(platform))
    throw new Error('Expected platform: mac, linux or win')
  const root = await realpath(directory)
  const inside = (path) => {
    const rel = relative(root, path)
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  }
  async function localFile(url) {
    if (typeof url !== 'string' || !url) throw new Error('Missing asset URL/path')
    const path = decodeURIComponent(url)
    if (isAbsolute(path) || /[\\:?#\0]/.test(path) || path.split('/').includes('..')) {
      throw new Error(`Unsafe asset path: ${url}`)
    }
    const resolved = resolve(root, path)
    if (!inside(resolved) || !inside(await realpath(resolved)))
      throw new Error(`Asset escapes output directory: ${url}`)
    if (!(await stat(resolved)).isFile()) throw new Error(`Not a file: ${url}`)
    return resolved
  }
  async function verifyFile(entry, requireSize = true) {
    const path = await localFile(entry.url)
    const size = (await stat(path)).size
    if (
      (requireSize || entry.size !== undefined) &&
      (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size !== size)
    ) {
      throw new Error(`Size mismatch: ${entry.url}`)
    }
    const hash = createHash('sha512')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    if (hash.digest('base64') !== entry.sha512) throw new Error(`SHA512 mismatch: ${entry.url}`)
    return path
  }
  const manifests = (await readdir(root)).filter((name) => /^latest.*\.yml$/.test(name)).sort()
  if (!manifests.length) throw new Error('No latest*.yml update manifests found')
  const expectedManifest = { mac: 'latest-mac.yml', linux: 'latest-linux.yml', win: 'latest.yml' }[
    platform
  ]
  if (!manifests.includes(expectedManifest))
    throw new Error(`Missing platform manifest: ${expectedManifest}`)
  for (const name of manifests) {
    const manifest = yaml.load(await readFile(await localFile(name), 'utf8'))
    if (
      typeof manifest?.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(manifest.version) ||
      (version !== undefined && manifest.version !== version)
    ) {
      throw new Error(`Invalid/unexpected version in ${name}: ${manifest?.version}`)
    }
    if (!Array.isArray(manifest.files) || !manifest.files.length)
      throw new Error(`Missing files in ${name}`)
    const paths = []
    for (const entry of manifest.files) paths.push(await verifyFile(entry))
    if (manifest.path !== undefined)
      await verifyFile({ url: manifest.path, sha512: manifest.sha512, size: manifest.size }, false)
    if (manifest.url !== undefined)
      await verifyFile({ url: manifest.url, sha512: manifest.sha512, size: manifest.size }, false)
    const extension = { mac: '.zip', linux: '.AppImage', win: '.exe' }[platform]
    if (!paths.some((path) => path.endsWith(extension)))
      throw new Error(`${name} requires an updater ${extension} payload`)
  }
  return { manifests, version }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, platform, version] = process.argv.slice(2)
  if (!directory || !platform || !version) {
    console.error(
      'Usage: node scripts/verify-update-assets.mjs <output-directory> <mac|linux|win> <expected-version>'
    )
    process.exitCode = 1
  } else {
    try {
      const result = await verifyUpdateAssets(directory, { platform, version })
      console.log(`Verified ${result.manifests.join(', ')} (${version}, ${platform})`)
    } catch (error) {
      console.error(`Invalid updater assets: ${error.message}`)
      process.exitCode = 1
    }
  }
}

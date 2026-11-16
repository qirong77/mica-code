import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { verifyUpdateAssets } from './verify-update-assets.mjs'

const roots = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture(extension = '.zip', manifestName = 'latest-mac.yml') {
  const root = await mkdtemp(join(tmpdir(), 'mica-update-assets-'))
  roots.push(root)
  const dir = join(root, 'dist')
  await mkdir(dir)
  const data = Buffer.from('updater fixture')
  const file = `mica-1.0.42${extension}`
  const sha512 = createHash('sha512').update(data).digest('base64')
  const manifest = {
    version: '1.0.42',
    files: [{ url: file, size: data.length, sha512 }],
    path: file,
    sha512
  }
  await writeFile(join(dir, file), data)
  const save = () => writeFile(join(dir, manifestName), yaml.dump(manifest))
  await save()
  return { root, dir, file, manifest, data, save }
}
const mac = { platform: 'mac', version: '1.0.42' }

test('valid mac ZIP and legacy path', async () => {
  const f = await fixture()
  expect((await verifyUpdateAssets(f.dir, mac)).manifests).toEqual(['latest-mac.yml'])
})
test('valid Linux AppImage and Windows latest.yml', async () => {
  const linux = await fixture('.AppImage', 'latest-linux.yml')
  await verifyUpdateAssets(linux.dir, { ...mac, platform: 'linux' })
  const windows = await fixture('.exe', 'latest.yml')
  await verifyUpdateAssets(windows.dir, { ...mac, platform: 'win' })
})
test('rejects bad file hash', async () => {
  const f = await fixture()
  f.manifest.files[0].sha512 = 'bad'
  await f.save()
  await expect(verifyUpdateAssets(f.dir, mac)).rejects.toThrow('SHA512 mismatch')
})
test('rejects wrong size', async () => {
  const f = await fixture()
  f.manifest.files[0].size++
  await f.save()
  await expect(verifyUpdateAssets(f.dir, mac)).rejects.toThrow('Size mismatch')
})
test('rejects missing referenced file', async () => {
  const f = await fixture()
  await rm(join(f.dir, f.file))
  await expect(verifyUpdateAssets(f.dir, mac)).rejects.toThrow()
})
test('rejects DMG-only mac manifest and ZIP-only Linux manifest', async () => {
  const f = await fixture('.dmg')
  await expect(verifyUpdateAssets(f.dir, mac)).rejects.toThrow('.zip payload')
  const zip = await fixture('.zip', 'latest-linux.yml')
  await expect(verifyUpdateAssets(zip.dir, { ...mac, platform: 'linux' })).rejects.toThrow(
    '.AppImage payload'
  )
})
test('requires the platform-specific channel manifest', async () => {
  const f = await fixture('.AppImage', 'latest-wrong.yml')
  await expect(verifyUpdateAssets(f.dir, { ...mac, platform: 'linux' })).rejects.toThrow(
    'Missing platform manifest: latest-linux.yml'
  )
})
test('rejects unexpected version and missing manifests', async () => {
  const f = await fixture()
  await expect(verifyUpdateAssets(f.dir, { ...mac, version: '1.0.43' })).rejects.toThrow('version')
  await rm(join(f.dir, 'latest-mac.yml'))
  await expect(verifyUpdateAssets(f.dir, mac)).rejects.toThrow('No latest')
})
test('rejects traversal, encoded traversal, absolute URLs and Windows paths', async () => {
  const f = await fixture()
  for (const url of [
    '../outside.zip',
    '%2e%2e/outside.zip',
    '/outside.zip',
    'https://example.com/a.zip',
    'C:\\outside.zip'
  ]) {
    f.manifest.files[0].url = url
    await f.save()
    await expect(verifyUpdateAssets(f.dir, mac)).rejects.toThrow('Unsafe asset path')
  }
})
test('rejects legacy path missing file or bad hash independently', async () => {
  const f = await fixture()
  f.manifest.path = 'missing.zip'
  await f.save()
  await expect(verifyUpdateAssets(f.dir, mac)).rejects.toThrow()
  f.manifest.path = f.file
  f.manifest.sha512 = 'bad'
  await f.save()
  await expect(verifyUpdateAssets(f.dir, mac)).rejects.toThrow('SHA512 mismatch')
})
test('rejects payload and manifest symlink escapes', async () => {
  const f = await fixture()
  const outside = join(f.root, 'outside.zip')
  await writeFile(outside, f.data)
  await rm(join(f.dir, f.file))
  await symlink(outside, join(f.dir, f.file))
  await expect(verifyUpdateAssets(f.dir, mac)).rejects.toThrow('escapes output directory')
  const externalManifest = join(f.root, 'external.yml')
  await writeFile(externalManifest, JSON.stringify(f.manifest))
  await rm(join(f.dir, 'latest-mac.yml'))
  await symlink(externalManifest, join(f.dir, 'latest-mac.yml'))
  await expect(verifyUpdateAssets(f.dir, mac)).rejects.toThrow('escapes output directory')
})

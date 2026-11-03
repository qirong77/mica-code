import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileIconAssets } from '../../../scripts/file-icon-assets.mjs'
import manifest from './vscode-icons-manifest.json'

const rendererRoot = fileURLToPath(new URL('..', import.meta.url))
const iconDir = join(rendererRoot, 'assets/file-icons')

async function loadIcons(command) {
  const plugin = fileIconAssets()
  const emitted = new Map()
  plugin.configResolved({
    command,
    root: rendererRoot,
    base: '/nested/',
    server: {},
    build: { watch: false }
  })
  const id = plugin.resolveId('virtual:file-icon-assets')
  const code = await plugin.load.call(
    {
      addWatchFile() {},
      emitFile(asset) {
        const ref = `ref${emitted.size}`
        emitted.set(asset.name.replace(/\.svg$/, ''), { ...asset, ref })
        return ref
      }
    },
    id
  )
  return { code, emitted }
}

describe('file icon build assets', () => {
  it('emits every reachable icon as an independent, unchanged SVG', async () => {
    const { code, emitted } = await loadIcons('build')
    const expected = new Set([
      `default_${manifest.defaults.file}`,
      `default_${manifest.defaults.folder}`,
      `default_${manifest.defaults.folder}_opened`
    ])
    for (const name of [...Object.values(manifest.files), ...Object.values(manifest.extensions)]) {
      expected.add(`file_type_${name}`)
    }
    expected.add(`file_type_${manifest.defaults.file}`)
    for (const name of [...Object.values(manifest.folders), manifest.defaults.folder]) {
      expected.add(`folder_type_${name}`)
      expected.add(`folder_type_${name}_opened`)
    }
    for (const name of expected) {
      const source = join(iconDir, `${name}.svg`)
      if (!existsSync(source)) continue // FileIcon falls back for missing variants.
      const asset = emitted.get(name)
      expect(asset?.type).toBe('asset')
      expect(asset.source.equals(readFileSync(source))).toBe(true)
      expect(code).toContain(`${JSON.stringify(name)}: import.meta.ROLLDOWN_FILE_URL_${asset.ref}`)
    }
    expect([...emitted.keys()].every((name) => expected.has(name))).toBe(true)
  })

  it('serves the same icon names beneath the configured development base', async () => {
    const { code: buildCode, emitted } = await loadIcons('build')
    expect(buildCode).toBeTruthy()
    const { code } = await loadIcons('serve')
    const icons = JSON.parse(code.slice('export default '.length))
    expect(Object.keys(icons).sort()).toEqual([...emitted.keys()].sort())
    for (const [name, url] of Object.entries(icons)) {
      expect(url).toBe(`/nested/assets/file-icons/${name}.svg`)
    }
  })
})

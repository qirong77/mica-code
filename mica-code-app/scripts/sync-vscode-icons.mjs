import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const VSCODE_ICONS_COMMIT = '0d1ac3107adba5c0868beaa0db7527f55835a5bd'
const ARCHIVE_URL = `https://codeload.github.com/vscode-icons/vscode-icons/tar.gz/${VSCODE_ICONS_COMMIT}`

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const iconsTarget = join(appRoot, 'src/renderer/assets/file-icons')
const manifestTarget = join(appRoot, 'src/renderer/src/vscode-icons-manifest.json')
const localFileOverrides = {
  '.bun.lock': 'bun',
  '.bun.lockb': 'bun'
}

const sortedObject = (map) =>
  Object.fromEntries([...map].sort(([left], [right]) => left.localeCompare(right)))

function addFileNames(target, entry) {
  for (const filename of entry.extensions ?? []) target.set(filename.toLowerCase(), entry.icon)

  for (const base of entry.filenamesGlob ?? []) {
    for (const extension of entry.extensionsGlob ?? []) {
      target.set(`${base}.${extension}`.toLowerCase(), entry.icon)
    }
  }
}

function buildManifest(fileCollection, folderCollection) {
  const files = new Map()
  const extensions = new Map()
  const folders = new Map()

  for (const entry of fileCollection.supported) {
    if (entry.disabled) continue
    for (const language of entry.languages ?? []) {
      for (const extension of language.knownExtensions ?? []) {
        extensions.set(extension.toLowerCase().replace(/^\./, ''), entry.icon)
      }
    }
  }

  for (const entry of fileCollection.supported) {
    if (entry.disabled) continue
    if (entry.filename) addFileNames(files, entry)
    else
      for (const extension of entry.extensions ?? [])
        extensions.set(extension.toLowerCase(), entry.icon)
  }
  for (const [filename, icon] of Object.entries(localFileOverrides)) files.set(filename, icon)

  for (const entry of folderCollection.supported) {
    if (entry.disabled) continue
    for (const folder of entry.extensions ?? []) folders.set(folder.toLowerCase(), entry.icon)
  }

  return {
    source: {
      repository: 'https://github.com/vscode-icons/vscode-icons',
      commit: VSCODE_ICONS_COMMIT,
      license: 'CC BY-SA 4.0'
    },
    defaults: {
      file: fileCollection.default.file.icon,
      folder: folderCollection.default.folder.icon
    },
    files: sortedObject(files),
    extensions: sortedObject(extensions),
    folders: sortedObject(folders)
  }
}

async function validateManifestIcons(manifest, iconsSource) {
  const available = new Set((await readdir(iconsSource)).filter((name) => name.endsWith('.svg')))
  const required = new Set([
    `default_${manifest.defaults.file}.svg`,
    `default_${manifest.defaults.folder}.svg`,
    `default_${manifest.defaults.folder}_opened.svg`,
    ...Object.values(manifest.files).map((icon) => `file_type_${icon}.svg`),
    ...Object.values(manifest.extensions).map((icon) => `file_type_${icon}.svg`),
    ...Object.values(manifest.folders).flatMap((icon) => [
      `folder_type_${icon}.svg`,
      `folder_type_${icon}_opened.svg`
    ])
  ])
  const missing = [...required].filter((name) => !available.has(name))
  if (missing.length > 0) {
    throw new Error(`vscode-icons manifest references missing assets:\n${missing.join('\n')}`)
  }
}

async function main() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'mica-vscode-icons-'))
  try {
    const archivePath = join(temporaryRoot, 'source.tar.gz')
    const response = await fetch(ARCHIVE_URL)
    if (!response.ok) throw new Error(`Failed to download vscode-icons: HTTP ${response.status}`)
    await writeFile(archivePath, Buffer.from(await response.arrayBuffer()))
    execFileSync('tar', ['-xzf', archivePath, '-C', temporaryRoot])

    const sourceRoot = join(temporaryRoot, `vscode-icons-${VSCODE_ICONS_COMMIT}`)
    const [{ extensions: fileCollection }, { extensions: folderCollection }] = await Promise.all([
      import(pathToFileURL(join(sourceRoot, 'src/iconsManifest/supportedExtensions.ts')).href),
      import(pathToFileURL(join(sourceRoot, 'src/iconsManifest/supportedFolders.ts')).href)
    ])
    const manifest = buildManifest(fileCollection, folderCollection)
    const iconsSource = join(sourceRoot, 'icons')
    await validateManifestIcons(manifest, iconsSource)

    await rm(iconsTarget, { recursive: true, force: true })
    await mkdir(dirname(iconsTarget), { recursive: true })
    await cp(iconsSource, iconsTarget, { recursive: true })
    await writeFile(manifestTarget, `${JSON.stringify(manifest, null, 2)}\n`)

    console.log(
      `Synced vscode-icons ${VSCODE_ICONS_COMMIT}: ` +
        `${Object.keys(manifest.files).length} filenames, ` +
        `${Object.keys(manifest.extensions).length} extensions, ` +
        `${Object.keys(manifest.folders).length} folders`
    )
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

await main()

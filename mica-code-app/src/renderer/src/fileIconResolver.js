import iconManifest from './vscode-icons-manifest.json'

export const defaultFileIconName = iconManifest.defaults.file
export const defaultFolderIconName = iconManifest.defaults.folder

function basename(path) {
  return String(path || '')
    .replaceAll('\\', '/')
    .split('/')
    .pop()
    .toLowerCase()
}

export function resolveFileIconName(path) {
  const name = basename(path)
  const filenameMatch = iconManifest.files[name]
  if (filenameMatch) return filenameMatch

  const parts = name.split('.')
  for (let index = 1; index < parts.length; index += 1) {
    const extensionMatch = iconManifest.extensions[parts.slice(index).join('.')]
    if (extensionMatch) return extensionMatch
  }

  return defaultFileIconName
}

export function resolveFolderIconName(path) {
  return iconManifest.folders[basename(path)] || defaultFolderIconName
}

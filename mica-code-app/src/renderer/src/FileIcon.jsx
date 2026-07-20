import {
  defaultFileIconName,
  defaultFolderIconName,
  resolveFileIconName,
  resolveFolderIconName
} from './fileIconResolver'

const iconModules = import.meta.glob('../assets/file-icons/*.svg', {
  eager: true,
  query: '?url',
  import: 'default'
})

const iconUrls = new Map(
  Object.entries(iconModules).map(([path, url]) => [
    path
      .split('/')
      .pop()
      .replace(/\.svg$/, ''),
    url
  ])
)

const defaultFileIcon = iconUrls.get(`default_${defaultFileIconName}`)
const defaultFolderIcon = iconUrls.get(`default_${defaultFolderIconName}`)
const defaultFolderOpenedIcon = iconUrls.get(`default_${defaultFolderIconName}_opened`)

export function resolveFileIcon(path) {
  const icon = resolveFileIconName(path)
  return iconUrls.get(`file_type_${icon}`) || defaultFileIcon
}

export function resolveFolderIcon(path, expanded = false) {
  const icon = resolveFolderIconName(path)
  const suffix = expanded ? '_opened' : ''
  return (
    iconUrls.get(`folder_type_${icon}${suffix}`) ||
    iconUrls.get(`folder_type_${icon}`) ||
    (expanded ? defaultFolderOpenedIcon : defaultFolderIcon)
  )
}

export function FileIcon({ name, className = '', ...props }) {
  return (
    <img
      src={resolveFileIcon(name)}
      alt=""
      aria-hidden="true"
      draggable="false"
      className={`shrink-0 object-contain ${className}`}
      {...props}
    />
  )
}

export function FolderIcon({ name, expanded = false, className = '', ...props }) {
  return (
    <img
      src={resolveFolderIcon(name, expanded)}
      alt=""
      aria-hidden="true"
      draggable="false"
      className={`shrink-0 object-contain ${className}`}
      {...props}
    />
  )
}

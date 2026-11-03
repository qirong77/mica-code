import {
  defaultFileIconName,
  defaultFolderIconName,
  resolveFileIconName,
  resolveFolderIconName
} from './fileIconResolver'
import iconAssets from 'virtual:file-icon-assets'

// 虚拟模块只列出清单能命中的图标，并始终给出独立文件 URL；浏览器按需加载。
const iconUrls = new Map(Object.entries(iconAssets))

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

/** Shared icon entry point for anything that renders a file-system node. */
export function FileSystemIcon({ name, type = 'file', expanded = false, ...props }) {
  return type === 'directory' ? (
    <FolderIcon name={name} expanded={expanded} {...props} />
  ) : (
    <FileIcon name={name} {...props} />
  )
}

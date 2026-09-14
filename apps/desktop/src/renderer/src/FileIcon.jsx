import {
  defaultFileIconName,
  defaultFolderIconName,
  resolveFileIconName,
  resolveFolderIconName
} from './fileIconResolver'

// `?no-inline` 必须保留：内联阈值以下的图标会被 Vite 塞成 data URI，1567 个图标
// 里有 1429 个能整块进主 bundle（约 2.1MB），而这些图标只在对应行渲染时才需要。
// 产出成独立文件后，映射表只留短 URL，图标由浏览器按需取（Electron 走 file://、
// 网页走运行时静态服务，两种方式都命中）。
const iconModules = import.meta.glob('../assets/file-icons/*.svg', {
  eager: true,
  query: '?url&no-inline',
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

/** Shared icon entry point for anything that renders a file-system node. */
export function FileSystemIcon({ name, type = 'file', expanded = false, ...props }) {
  return type === 'directory' ? (
    <FolderIcon name={name} expanded={expanded} {...props} />
  ) : (
    <FileIcon name={name} {...props} />
  )
}

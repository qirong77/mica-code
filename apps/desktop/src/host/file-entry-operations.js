import { lstat, mkdir, rename, writeFile } from 'fs/promises'
import path from 'path'

function nameParts(value, basenameOnly = false) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('名称不能为空')
  const name = value.trim()
  if (name.includes('\0') || /[\r\n]/.test(name)) throw new Error('名称不能包含控制字符')
  if (basenameOnly && /[/\\]/.test(name)) throw new Error('重命名时不能包含路径分隔符')
  if (/^[/\\]/.test(name) || /^[a-z]:/i.test(name)) throw new Error('请输入相对路径')
  const parts = name.split(/[/\\]/)
  if (parts.some((part) => !part.trim() || part === '.' || part === '..')) {
    throw new Error('路径不能包含空名称、. 或 ..')
  }
  return parts
}

function entryError(code) {
  return Object.assign(new Error(code), { code })
}

function operationError(error, action) {
  const reasons = {
    EEXIST: '同名文件或文件夹已存在，请使用其他名称',
    ENOENT: '文件或文件夹不存在，请刷新后重试',
    ENOTDIR: '路径中有项目不是文件夹',
    ELOOP: '路径中的文件夹不能是符号链接',
    EACCES: '没有权限操作此文件或文件夹',
    EPERM: '没有权限操作此文件或文件夹',
    EROFS: '所在文件系统是只读的',
    ENAMETOOLONG: '名称或路径过长，请缩短后重试',
    ENOSPC: '磁盘空间不足'
  }
  return Object.assign(
    new Error(`${action}失败：${reasons[error?.code] || error?.message || '未知错误'}`, {
      cause: error
    }),
    { code: error?.code }
  )
}

export async function createFileEntry(directory, name, type) {
  const parts = nameParts(name)
  if (type !== 'file' && type !== 'directory') throw new Error('类型必须是文件或文件夹')
  const target = path.join(directory, ...parts)
  try {
    let parent = directory
    for (const part of parts.slice(0, -1)) {
      parent = path.join(parent, part)
      try {
        await mkdir(parent, { recursive: false })
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
      const info = await lstat(parent)
      if (info.isSymbolicLink()) throw entryError('ELOOP')
      if (!info.isDirectory()) throw entryError('ENOTDIR')
    }
    if (type === 'directory') await mkdir(target, { recursive: false })
    else await writeFile(target, '', { flag: 'wx' })
    return target
  } catch (error) {
    throw operationError(error, '新建')
  }
}

export async function renameFileEntry(source, name) {
  const [basename] = nameParts(name, true)
  const target = path.join(path.dirname(source), basename)
  if (source === target) return target
  try {
    let exists = false
    try {
      await lstat(target)
      exists = true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (exists) throw entryError('EEXIST')
    await rename(source, target)
    return target
  } catch (error) {
    throw operationError(error, '重命名')
  }
}

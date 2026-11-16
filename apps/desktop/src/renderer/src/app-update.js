export function updateButtonState(remote, native) {
  if (native?.status === 'downloaded') return { visible: true, label: '重启更新', tone: 'primary' }
  if (native?.status === 'downloading') {
    const percent = Number.isFinite(native.progress) ? ` ${Math.round(native.progress)}%` : ''
    return { visible: true, label: `下载更新${percent}`, tone: 'primary' }
  }
  if (native?.status === 'available') return { visible: true, label: '下载更新', tone: 'primary' }
  if (remote?.available) return { visible: true, label: '有新版本', tone: 'primary' }
  return { visible: false, label: '', tone: undefined }
}

export function updateCheckUrl(force = false) {
  return force ? '/api/update/check?force=1' : '/api/update/check'
}

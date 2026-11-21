// 样式顺序与真实宿主一致：共享入口的配置页 / Arco 样式 → app.css → 插件 chunk。
import { createRoot } from 'react-dom/client'
import { ArcoProvider } from '@mica-config-ui/web'
import '../../src/renderer/assets/app.css'

const params = new URLSearchParams(location.search)
const theme = params.get('theme')
if (theme) {
  document.documentElement.setAttribute('data-theme', theme)
  document.documentElement.setAttribute(
    'data-appearance',
    theme.includes('light') || theme === 'latte' ? 'light' : 'dark'
  )
}
document.body.classList.add('mica-arco-theme')

const { Launcher } = await import('plugins/mica-maccy/desktop.jsx')

const now = Date.now()

/** 造一张「截图」：渐变底 + 标题条 + 几行灰块，缩略图和大图都能看出比例。 */
function shot(width, height, from, to, caption) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const paint = canvas.getContext('2d')
  const gradient = paint.createLinearGradient(0, 0, width, height)
  gradient.addColorStop(0, from)
  gradient.addColorStop(1, to)
  paint.fillStyle = gradient
  paint.fillRect(0, 0, width, height)
  paint.fillStyle = 'rgba(255,255,255,.82)'
  paint.fillRect(0, 0, width, Math.round(height * 0.12))
  paint.fillStyle = 'rgba(17,24,39,.10)'
  for (let index = 0; index < 4; index += 1) {
    paint.beginPath()
    paint.roundRect(
      width * 0.08,
      height * (0.24 + index * 0.16),
      width * (0.44 + ((index * 7) % 3) * 0.12),
      Math.max(6, height * 0.035),
      4
    )
    paint.fill()
  }
  paint.fillStyle = 'rgba(17,24,39,.5)'
  paint.font = `500 ${Math.round(height * 0.07)}px -apple-system, "SF Pro Text", sans-serif`
  paint.fillText(caption, width * 0.08, height * 0.88)
  return canvas.toDataURL('image/png')
}

const wide = { big: shot(1200, 750, '#dbeafe', '#c7d2fe', '截图 1200 × 750'), small: shot(320, 200, '#dbeafe', '#c7d2fe', '') }
const tall = { big: shot(720, 1080, '#dcfce7', '#bbf7d0', '截图 720 × 1080'), small: shot(200, 300, '#dcfce7', '#bbf7d0', '') }

const items = [
  {
    id: 'pinned',
    title: '给设计评审的地址',
    kind: 'text',
    textPreview: 'https://meet.example.com/mica-design-review',
    source: { name: 'Safari', bundleId: 'com.apple.Safari' },
    pinned: true,
    pinKey: 'a',
    createdAt: now - 36 * 60 * 60 * 1000,
    lastCopiedAt: now - 36 * 60 * 60 * 1000,
    copyCount: 6,
    bytes: 52
  },
  {
    id: 'shot-wide',
    title: '图片 1200×750',
    kind: 'image',
    textPreview: '',
    source: { name: 'iShot Pro', bundleId: 'com.ishot.pro' },
    pinned: false,
    pinKey: '',
    createdAt: now - 40 * 1000,
    lastCopiedAt: now - 40 * 1000,
    copyCount: 1,
    bytes: 486 * 1024
  },
  {
    id: 'long-text',
    title:
      'Mica Maccy：移除多余按钮，改成 31 天自动清理；历史里只留搜索结果、内容预览和右键整理动作，底栏只突出 ⇧⌘C。',
    kind: 'text',
    textPreview:
      'Mica Maccy：移除多余按钮，改成 31 天自动清理\n\n历史里只留搜索结果、内容预览和右键整理动作。底栏只突出 ⇧⌘C，不再把快捷键列成一张说明表。\n\n- 点一下条目就是复制，⌥ 点击直接回贴\n- 固定 / 重命名 / 删除在右键菜单里\n- 过期条目由后台按 31 天清理，不再需要「清空历史」按钮',
    source: { name: 'Visual Studio Code', bundleId: 'com.microsoft.VSCode' },
    pinned: false,
    pinKey: '',
    createdAt: now - 8 * 60 * 1000,
    lastCopiedAt: now - 8 * 60 * 1000,
    copyCount: 2,
    bytes: 4213
  },
  {
    id: 'shot-tall',
    title: '图片 720×1080',
    kind: 'image',
    textPreview: '',
    source: { name: 'CleanShot X', bundleId: 'pl.maketheweb.cleanshotx' },
    pinned: false,
    pinKey: '',
    createdAt: now - 3 * 60 * 60 * 1000,
    lastCopiedAt: now - 3 * 60 * 60 * 1000,
    copyCount: 1,
    bytes: 912 * 1024
  },
  {
    id: 'files',
    title: '三个文件',
    kind: 'files',
    textPreview: '',
    source: { name: 'Finder', bundleId: 'com.apple.finder' },
    pinned: false,
    pinKey: '',
    createdAt: now - 26 * 60 * 60 * 1000,
    lastCopiedAt: now - 26 * 60 * 60 * 1000,
    copyCount: 1,
    bytes: 0
  }
]

/** 真实 detail 一定带 `item`：界面据此判断这份内容还对应着当前选中项。 */
const detailOf = (id, rest) => ({ id, item: items.find((item) => item.id === id), ...rest })

const details = {
  pinned: {
    ...detailOf('pinned', {}),
    text: 'https://meet.example.com/mica-design-review',
    previewImage: null,
    files: [],
    types: ['public.utf8-plain-text']
  },
  'long-text': {
    ...detailOf('long-text', {}),
    text: items[2].textPreview,
    previewImage: null,
    files: [],
    types: ['public.html', 'public.utf8-plain-text']
  },
  files: {
    ...detailOf('files', {}),
    text: '',
    previewImage: null,
    files: ['/Users/me/Desktop/design/review.pdf', '/Users/me/Desktop/design/notes.md', '/Users/me/Desktop/design/cover.png'],
    types: ['public.file-url']
  },
  'shot-wide': { ...detailOf('shot-wide', {}), text: '', previewImage: wide.big, files: [], types: ['public.png'] },
  'shot-tall': { ...detailOf('shot-tall', {}), text: '', previewImage: tall.big, files: [], types: ['public.png'] }
}

const empty = params.get('empty') === '1'
const paused = params.get('paused') === '1'

/** 假 launcher：只回答界面需要的几件事，不碰真实剪贴板。 */
const api = {
  launcher: {
    status: async () => ({ shortcut: 'CommandOrControl+Shift+C', registered: true }),
    request: async (action, input) => {
      if (action === 'list') {
        // 和真实 searchHistory 一样：先按类型筛选，再按关键词过滤，计数说的是过滤后的条数。
        const query = String(input?.query ?? '').trim().toLowerCase()
        const list = (empty ? [] : items)
          .filter((item) => {
            if (input?.filter === 'pinned') return item.pinned
            if (input?.filter && input.filter !== 'all') return item.kind === input.filter
            return true
          })
          .filter((item) =>
            query ? `${item.title} ${item.textPreview} ${item.source?.name}`.toLowerCase().includes(query) : true
          )
        return {
          items: list,
          total: list.length,
          pinnedCount: list.filter((item) => item.pinned).length,
          paused,
          ignoreNext: false,
          settings: {
            pasteAutomatically: false,
            searchMode: 'fuzzy',
            sortBy: 'lastCopiedAt',
            showFooter: true,
            showPreview: true
          },
          native: { supported: true, accessibility: true, error: '' }
        }
      }
      if (action === 'detail') return details[input?.id] ?? {}
      if (action === 'thumbnails') {
        const images = {}
        for (const id of input?.ids ?? []) {
          if (id === 'shot-wide') images[id] = wide.small
          if (id === 'shot-tall') images[id] = tall.small
        }
        return { images }
      }
      return { ok: true }
    },
    close: async () => ({}),
    configure: async () => ({}),
    retry: async () => ({})
  }
}

function measure() {
  const frame = document.getElementById('probe-frame').getBoundingClientRect()
  const head = document.querySelector('.maccy-head')
  const rows = [...document.querySelectorAll('.maccy-row')]
  const preview = document.querySelector('.maccy-preview')
  const menu = document.querySelector('.maccy-menu')
  const info = {
    frame: { width: Math.round(frame.width), height: Math.round(frame.height) },
    headerButtons: head ? head.querySelectorAll('button').length : -1,
    headerHeight: head ? Math.round(head.getBoundingClientRect().height) : 0,
    searchWidth: Math.round(document.querySelector('.maccy-input')?.getBoundingClientRect().width ?? 0),
    rowHeights: rows.map((row) => Math.round(row.getBoundingClientRect().height)),
    rowButtons: document.querySelectorAll('.maccy-row button').length,
    previewWidth: preview ? Math.round(preview.getBoundingClientRect().width) : 0,
    previewButtons: preview ? preview.querySelectorAll('button').length : 0,
    menuItems: menu ? menu.querySelectorAll('[role^="menuitem"]').length : 0,
    thumbnails: document.querySelectorAll('.maccy-thumbnail img').length,
    footer: document.querySelector('.maccy-foot')?.innerText ?? ''
  }
  const out = document.getElementById('probe-out')
  out.textContent = JSON.stringify(info)
  return info
}

function App() {
  return (
    <ArcoProvider>
      <Launcher api={api} />
    </ArcoProvider>
  )
}

createRoot(document.getElementById('root')).render(<App />)

// 图片缩略图与选中后的预览都是异步来的，量之前给它们一拍。
setTimeout(() => {
  window.__probeMeasure = measure
  measure()
}, 600)

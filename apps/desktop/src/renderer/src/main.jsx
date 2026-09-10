import { createRoot } from 'react-dom/client'
import App from './App'
import '../assets/app.css'
import { ensureMicaApi } from './transport'

// 页面在任何容器里都是同一份代码：window.mica 由 transport 适配层通过 HTTP + SSE
// 建立（Electron 外壳只是装载同一个地址）。连不上运行时时给出可读提示，不要白屏。
ensureMicaApi()
  .catch((error) => {
    console.error('初始化 mica 接口失败', error)
    renderBootError(error)
    return null
  })
  .then((api) => {
    if (!api) return
    createRoot(document.getElementById('root')).render(<App />)
  })

function renderBootError(error) {
  const root = document.getElementById('root')
  if (!root) return
  const box = document.createElement('div')
  box.className = 'flex h-full flex-col items-center justify-center gap-2 p-8 text-center'
  const title = document.createElement('p')
  title.className = 'text-sm text-[var(--chat-text)]'
  title.textContent = '无法连接 Mica Code 运行时'
  const hint = document.createElement('p')
  hint.className = 'text-xs text-[var(--chat-text-dim)]'
  hint.textContent = '请确认运行时进程仍在运行（npm run start:web 或重新启动应用）。'
  const detail = document.createElement('p')
  detail.className = 'max-w-md text-[11px] text-[var(--chat-text-dim)]'
  detail.textContent = String(error?.message || error)
  box.append(title, hint, detail)
  root.replaceChildren(box)
}

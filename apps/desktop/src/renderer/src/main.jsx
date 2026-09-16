import { createRoot } from 'react-dom/client'
import App from './App'
import '../assets/app.css'
import { ensureMicaApi } from './transport'
import { LOCAL_SERVER_URL, currentServerUrl, isLoopbackServer } from './servers'

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

  // 地址是切过去的另一台 mica 时（那台关机/重启了）给一条回本机的退路，
  // 否则整页停在错误页、连切换入口都点不到。
  if (!isLoopbackServer(currentServerUrl(window.location))) {
    const home = document.createElement('button')
    home.type = 'button'
    home.className =
      'mt-2 rounded-sm border border-white/10 bg-white/[.06] px-3 py-1 text-xs text-white hover:bg-white/10'
    home.textContent = '返回本机'
    home.addEventListener('click', () => window.location.assign(LOCAL_SERVER_URL))
    box.append(home)
  }
  root.replaceChildren(box)
}

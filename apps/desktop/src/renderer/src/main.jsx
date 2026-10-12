import { createRoot } from 'react-dom/client'
import App from './App'
import '../assets/app.css'
import { AccessDeniedError, ensureMicaApi, submitAccessToken } from './transport'
import { ensureUiState } from './ui-state'
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
    // 界面状态（草稿/工作区/面板布局）来自运行时：先取回来再渲染，第一帧就是上一次
    // 留下的样子，不用先画一个空界面再对齐。取不到不阻断启动——只是回到默认界面，
    // 比整页停在一个错误提示上可用。
    return ensureUiState()
      .catch((error) => console.error('初始化界面状态失败', error))
      .then(() => createRoot(document.getElementById('root')).render(<App />))
  })

function renderBootError(error) {
  const root = document.getElementById('root')
  if (!root) return
  // 需要凭据（或令牌失效）不是「连不上」：给一个能直接粘贴令牌的入口，
  // 否则用户只会看到一句不知道怎么办的报错。
  if (error instanceof AccessDeniedError) return renderAccessPrompt(root, error)
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

function renderAccessPrompt(root, error) {
  const box = document.createElement('div')
  box.className = 'flex h-full flex-col items-center justify-center gap-3 p-8 text-center'
  const title = document.createElement('p')
  title.className = 'text-sm text-[var(--chat-text)]'
  title.textContent = '这台 Mica Code 需要访问令牌'
  const hint = document.createElement('p')
  hint.className = 'max-w-md text-xs text-[var(--chat-text-dim)]'
  hint.textContent =
    '远程访问能拿到宿主终端与文件，因此需要凭据。请使用运行时启动时打印的局域网地址（已带令牌），或在下方粘贴令牌。'

  const row = document.createElement('div')
  row.className = 'flex items-center gap-2'
  const input = document.createElement('input')
  input.type = 'password'
  input.placeholder = '访问令牌'
  input.className =
    'w-72 rounded-sm border border-white/10 bg-white/[.06] px-2 py-1 text-xs text-white outline-none'
  const submit = document.createElement('button')
  submit.type = 'button'
  submit.className =
    'rounded-sm border border-white/10 bg-white/[.06] px-3 py-1 text-xs text-white hover:bg-white/10'
  submit.textContent = '进入'
  const status = document.createElement('p')
  status.className = 'text-[11px] text-[var(--chat-text-dim)]'
  status.textContent = String(error?.message || '')

  const enter = async () => {
    submit.disabled = true
    status.textContent = '正在验证…'
    const ok = await submitAccessToken(input.value.trim())
    submit.disabled = false
    if (ok) window.location.reload()
    else status.textContent = '令牌无效或已失效'
  }
  submit.addEventListener('click', () => void enter())
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void enter()
  })
  row.append(input, submit)
  box.append(title, hint, row, status)

  // 被切到的是另一台机器时给一条回本机的退路（与本机运行时的判定一致）
  if (!isLoopbackServer(currentServerUrl(window.location))) {
    const home = document.createElement('button')
    home.type = 'button'
    home.className =
      'rounded-sm border border-white/10 bg-white/[.06] px-3 py-1 text-xs text-white hover:bg-white/10'
    home.textContent = '返回本机'
    home.addEventListener('click', () => window.location.assign(LOCAL_SERVER_URL))
    box.append(home)
  }
  root.replaceChildren(box)
}

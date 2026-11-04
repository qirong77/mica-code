// 临时探针：验证隐藏窗口下截图/点击/出帧的能力边界（用完即删）
import { app, BrowserWindow, WebContentsView, session, nativeImage } from 'electron'
import { createServer } from 'node:http'

const SWITCH = 'disable-backgrounding-occluded-windows'
app.commandLine.appendSwitch(SWITCH)

const PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0">
<div id="box" style="width:600px;height:300px;background:#000"></div>
<div id="frame" style="font:20px monospace">0</div>
<script>
window.__frames = 0
window.__clicks = 0
window.__stamp = ''
document.body.addEventListener('click', () => { window.__clicks += 1 })
function tick () {
  window.__frames += 1
  document.getElementById('frame').textContent = window.__frames
  document.getElementById('box').style.background = '#000'
  requestAnimationFrame(tick)
}
requestAnimationFrame(tick)
</script></body>`

const log = []
function record(name, data) {
  log.push({ name, ...data })
  console.log('PROBE', name, JSON.stringify(data))
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** PNG 里有没有纯绿（页面里刚被改成 #00ff00 时出现） */
function hasGreen(buffer) {
  const bitmap = nativeImage.createFromBuffer(buffer).getBitmap()
  for (let i = 0; i + 3 < bitmap.length; i += 4) {
    const a = bitmap[i]
    const b = bitmap[i + 1]
    const c = bitmap[i + 2]
    const d = bitmap[i + 3]
    // BGRA / RGBA 都可能：任一排列里出现 (255,0,0)/(0,255,0) 的强信号就认为已刷新
    if (a === 0 && b === 255 && c === 0 && d === 255) return true
    if (a === 0 && b === 0 && c === 255 && d === 255) return true
  }
  return false
}

async function timed(fn) {
  const started = Date.now()
  try {
    const value = await fn()
    return { ok: true, ms: Date.now() - started, value }
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: String(error?.message || error) }
  }
}

async function withTimeout(promise, ms) {
  let timer = null
  const timeout = new Promise((_r, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/`

  const win = new BrowserWindow({
    width: 900,
    height: 640,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true }
  })
  // 和 browser-manager 一样：窗口装一个 WebContentsView，页面在视图里
  const shell = new BrowserWindow({ width: 900, height: 640, show: false })
  const view = new WebContentsView({
    webPreferences: { partition: 'persist:mica-probe-browser', contextIsolation: true, sandbox: true }
  })
  shell.contentView.addChildView(view)
  const contents = view.webContents
  contents.debugger.attach('1.3')
  await contents.debugger.sendCommand('Page.enable')
  await contents.debugger.sendCommand('Network.enable')
  await contents.loadURL(url)
  const send = (method, params = {}) => contents.debugger.sendCommand(method, params)

  await delay(400)
  record('hidden/visibilityState', await contents.executeJavaScript('document.visibilityState'))
  const f1 = await contents.executeJavaScript('window.__frames')
  await delay(400)
  const f2 = await contents.executeJavaScript('window.__frames')
  record('hidden/raf', { from: f1, to: f2, advanced: f2 > f1 + 1 })

  // 1) 隐藏窗口 + 默认 fromSurface 截图
  await contents.executeJavaScript("document.getElementById('box').style.background='#00ff00'")
  record(
    'hidden/capture-default',
    await timed(async () => {
      const shot = await withTimeout(send('Page.captureScreenshot', { format: 'png' }), 6000)
      const buffer = Buffer.from(shot.data, 'base64')
      return { bytes: buffer.length, fresh: hasGreen(buffer) }
    })
  )

  // 2) 隐藏窗口 + fromSurface:false
  await contents.executeJavaScript("document.getElementById('box').style.background='#000'")
  await delay(60)
  await contents.executeJavaScript("document.getElementById('box').style.background='#00ff00'")
  record(
    'hidden/capture-fromSurface-false',
    await timed(async () => {
      const shot = await withTimeout(
        send('Page.captureScreenshot', { format: 'png', fromSurface: false }),
        6000
      )
      const buffer = Buffer.from(shot.data, 'base64')
      return { bytes: buffer.length, fresh: hasGreen(buffer) }
    })
  )

  // 3) 隐藏窗口 + Emulation 尺寸覆盖后再截
  record(
    'hidden/capture-emulation',
    await timed(async () => {
      await withTimeout(
        send('Emulation.setDeviceMetricsOverride', {
          width: 900,
          height: 600,
          deviceScaleFactor: 1,
          mobile: false
        }),
        4000
      )
      const shot = await withTimeout(send('Page.captureScreenshot', { format: 'png' }), 6000)
      await send('Emulation.clearDeviceMetricsOverride').catch(() => {})
      return { bytes: Buffer.from(shot.data, 'base64').length }
    })
  )

  // 4) 隐藏窗口 + 整页截图（captureBeyondViewport）
  record(
    'hidden/capture-fullpage',
    await timed(async () => {
      const metrics = await withTimeout(send('Page.getLayoutMetrics'), 4000)
      const size = metrics.cssContentSize
      const shot = await withTimeout(
        send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 }
        }),
        8000
      )
      return {
        bytes: Buffer.from(shot.data, 'base64').length,
        contentSize: { width: size.width, height: size.height }
      }
    })
  )

  // 5) 隐藏窗口 + webContents.capturePage()
  record(
    'hidden/capturePage',
    await timed(async () => {
      const image = await withTimeout(contents.capturePage(), 5000)
      return { bytes: image.getSize(), empty: image.isEmpty() }
    })
  )

  // 6) 隐藏窗口 + 原生输入
  await contents.executeJavaScript('window.__clicks = 0')
  await withTimeout(
    send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 100, button: 'left', clickCount: 1 }),
    3000
  ).catch(() => {})
  await withTimeout(
    send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 100, y: 100, button: 'left', clickCount: 1 }),
    3000
  ).catch(() => {})
  await delay(150)
  record('hidden/native-click', { clicks: await contents.executeJavaScript('window.__clicks') })

  // 7) 隐藏窗口 + 合成点击（页面内事件）
  record(
    'hidden/synthetic-click',
    await timed(async () => {
      await contents.executeJavaScript(
        "(() => { const el = document.getElementById('box'); const r = el.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, view: window, clientX: r.x + 5, clientY: r.y + 5, button: 0 }; el.dispatchEvent(new MouseEvent('mousedown', o)); el.dispatchEvent(new MouseEvent('mouseup', o)); el.click(); return true })()"
      )
      await delay(120)
      return { clicks: await contents.executeJavaScript('window.__clicks') }
    })
  )

  // 8) 透明露出（setOpacity(0) + showInactive）后截图
  shell.setOpacity(0)
  shell.setIgnoreMouseEvents(true)
  shell.showInactive()
  await delay(250)
  record('reveal/isVisible', { visible: shell.isVisible(), opacity: shell.getOpacity() })
  await contents.executeJavaScript("document.getElementById('box').style.background='#00ff00'")
  record(
    'reveal/capture',
    await timed(async () => {
      const shot = await withTimeout(send('Page.captureScreenshot', { format: 'png' }), 6000)
      const buffer = Buffer.from(shot.data, 'base64')
      return { bytes: buffer.length, fresh: hasGreen(buffer) }
    })
  )

  // 9) 隐藏后 rAF 是否继续（透明露出之后的对照）
  shell.hide()
  shell.setOpacity(1)
  await delay(300)
  const f3 = await contents.executeJavaScript('window.__frames')
  await delay(400)
  const f4 = await contents.executeJavaScript('window.__frames')
  record('hidden-after-reveal/raf', { from: f3, to: f4, advanced: f4 > f3 + 1 })

  console.log('PROBE_SUMMARY', JSON.stringify({ log }, null, 2))
  server.close()
  win.destroy()
  shell.destroy()
  app.quit()
}

app.whenReady().then(main).catch((error) => {
  console.error('PROBE_FAILED', error)
  app.exit(1)
})

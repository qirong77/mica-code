// npm run build:app 后，在 apps/desktop 下执行：
// env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/check-mobile-viewport.mjs
// 用真实 DOM 聚焦与 CSS 布局验证；只模拟键盘视口，不连接运行时或打开用户会话。
import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = mkdtempSync(join(tmpdir(), 'mica-mobile-viewport-'))
app.setPath('userData', profile)
app.on('quit', () => rmSync(profile, { recursive: true, force: true }))

app.whenReady().then(async () => {
  let win
  try {
    const renderer = join(project, 'out/renderer')
    const html = readFileSync(join(renderer, 'index.html'), 'utf8')
    const cssFile = html.match(/href="\.\/([^\"]+\.css)"/)?.[1]
    assert.ok(cssFile, '先运行 npm run build:app 生成页面样式')
    const css = readFileSync(join(renderer, cssFile), 'utf8')
    const bundle = await build({
      root: project,
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        lib: {
          entry: join(project, 'src/renderer/src/viewport-sync.js'),
          formats: ['iife'],
          name: 'mobileViewport'
        }
      }
    })
    const output = Array.isArray(bundle) ? bundle[0].output : bundle.output
    const code = output.find((item) => item.type === 'chunk').code
    win = new BrowserWindow({
      show: false,
      width: 440,
      height: 956,
      useContentSize: true,
      webPreferences: { sandbox: true, backgroundThrottling: false }
    })
    await win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>${css}</style>
      <div id="root">
        <div class="relative flex size-full flex-col overflow-hidden">
          <main class="relative flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">
            <header class="safe-top flex h-8 shrink-0">对话</header>
            <div class="relative flex min-h-0 flex-1 flex-col overflow-hidden">
              <div class="chat-view flex">
                <div class="chat-scroll"><div class="chat-transcript">
                  ${'<p>历史消息</p>'.repeat(200)}
                </div></div>
                <div class="chat-composer-dock">
                  <div class="chat-composer">
                    <button class="chat-prompt-mark">❯</button>
                    <div class="chat-composer-input"><textarea rows="1"></textarea></div>
                    <div class="chat-composer-actions"><button>发送</button></div>
                  </div>
                  <div class="chat-status-line">模型</div>
                </div>
              </div>
            </div>
            <footer class="safe-bottom flex h-7 shrink-0">main / cwd</footer>
          </main>
        </div>
      </div>`)} `
    )
    await win.webContents.executeJavaScript(code)
    const results = await win.webContents.executeJavaScript(`(async () => {
      const viewport = Object.assign(new EventTarget(), {height: 956, offsetTop: 0, scale: 1});
      Object.defineProperty(window, 'visualViewport', {value: viewport});
      const stop = mobileViewport.syncVisualViewport(window, document);
      const input = document.querySelector('textarea');
      const list = document.querySelector('.chat-scroll');
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const snapshot = label => ({
        label,
        height: document.getElementById('root').clientHeight,
        inputBottom: input.getBoundingClientRect().bottom,
        footerBottom: document.querySelector('footer').getBoundingClientRect().bottom,
        headerTop: document.querySelector('header').getBoundingClientRect().top,
        listScroll: list.scrollTop,
        focused: document.activeElement === input
      });
      input.focus();
      list.scrollTop = 600;
      await wait(1100);
      let focusEvents = 0;
      input.addEventListener('focus', () => focusEvents++);
      const results = [];
      for (const label of ['already-focused', 'reopen-after-done']) {
        input.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, pointerType: 'touch'}));
        input.focus();
        // 键盘在触摸后才更新几何，不派发 resize/scroll，也没有第二个 focus 事件。
        await wait(80);
        viewport.height = 420;
        await frames();
        results.push(snapshot(label));
        viewport.height = 956;
        viewport.dispatchEvent(new Event('resize'));
        await frames();
        results.push(snapshot(label + '-dismissed'));
        await wait(1100);
      }
      stop();
      return {results, focusEvents};
    })()`)
    assert.equal(results.focusEvents, 0, '复现必须没有第二次 focus 事件')
    for (const result of results.results) {
      const expected = result.label.endsWith('-dismissed') ? 956 : 420
      assert.equal(result.height, expected, `${result.label}: 根高度应跟随键盘`)
      assert.ok(result.inputBottom <= expected, `${result.label}: 输入框应在可见区内`)
      assert.equal(result.footerBottom, expected, `${result.label}: 底栏应贴住可见区底部`)
      assert.equal(result.headerTop, 0, `${result.label}: 顶栏不应移出屏幕`)
      assert.equal(result.listScroll, 600, `${result.label}: 保留历史阅读位置`)
      assert.equal(result.focused, true, `${result.label}: 保留输入焦点`)
    }
    console.log(JSON.stringify(results, null, 2))
    console.log('移动端视口 DOM 回归检查通过（不替代 iPhone 真机软键盘验证）')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    win?.destroy()
    app.exit(process.exitCode || 0)
  }
})

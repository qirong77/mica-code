/**
 * 受控浏览器的端点目录与文档。**这是唯一事实来源**：主进程的 HTTP 路由表由它编译
 * （见 browser-core.js 的 compileRoutes），设置页的 Browser Control 一节、MCP server
 * 暴露给 agent 的操作清单也由它生成 —— 于是不会出现「文档写了但路由没实现」或反过来的漂移。
 */

import { withPathParams } from '../shared/endpoint-params.js'

export const BROWSER_SERVICE_APP = 'mica-code-browser'
export const BROWSER_SERVICE_VERSION = 1

/** 「未知操作」时最多列几个相近的名字：再多就退化成一整份清单。 */
const MAX_ACTION_SUGGESTIONS = 3

/**
 * 模型最常写错的那几个同义词。它们的编辑距离与真实 action 名相距太远，算不出来；
 * 而这类错误占了「未知操作」的绝大多数（`press` / `goto` / `evaluate` 的别名）。
 */
const ACTION_ALIASES = {
  press: 'keys',
  key: 'keys',
  keyboard: 'keys',
  hotkey: 'keys',
  goto: 'navigate',
  read: 'content',
  readcontent: 'content',
  getcontent: 'content',
  text: 'content',
  js: 'evaluate',
  eval: 'evaluate',
  execute: 'evaluate',
  shot: 'screenshot',
  capture: 'screenshot'
}

const ownerParam = {
  name: 'x-mica-owner',
  in: 'header',
  required: false,
  description:
    '归属的会话（Mica 会话 id 或工作区页签 id）。agent 里用 $MICA_BROWSER_OWNER，写进这个头，窗口就会挂到该会话的图标行上。新建窗口必须带它。'
}

const RAW_ENDPOINTS = [
  {
    id: 'health',
    method: 'GET',
    path: '/browser/health',
    summary: '服务探活',
    params: [],
    returns: '{ ok, app, version }'
  },
  {
    id: 'capabilities',
    method: 'GET',
    path: '/browser/capabilities',
    summary: '能力与端点目录（机器可读，改路由时同源）',
    params: [],
    returns: '{ ok, app, version, endpoints: [{ id, method, path, summary }] }'
  },
  {
    id: 'docs',
    method: 'GET',
    path: '/browser/docs',
    summary: '完整文档与给 agent 的短提示',
    params: [],
    returns: '{ ok, endpoints, markdown, guide }'
  },
  {
    id: 'listBrowsers',
    method: 'GET',
    path: '/browser/browsers',
    summary: '列出所有受控浏览器窗口（含标签页摘要）',
    params: [],
    returns: '{ ok, browsers: [Browser] }',
    example: 'curl -s "$MICA_BROWSER_URL/browser/browsers"'
  },
  {
    id: 'createBrowser',
    method: 'POST',
    path: '/browser/browsers',
    summary: '新开一个受控浏览器窗口（默认隐藏着建，全程不打扰用户）',
    params: [
      { name: 'url', in: 'body', required: false, description: '初始地址，省略则开 about:blank' },
      { name: 'owner', in: 'body', required: false, description: '归属会话 id（与请求头二选一，必须有一个）' },
      {
        name: 'label',
        in: 'body',
        required: false,
        description: '窗口标签，界面上用它区分多个窗口'
      },
      {
        name: 'show',
        in: 'body',
        required: false,
        description: '只有明确要给用户演示时才传 true：建完立刻显示到前台'
      },
      ownerParam
    ],
    returns: '{ ok, browser }',
    example:
      'curl -s -X POST "$MICA_BROWSER_URL/browser/browsers" -H \'content-type: application/json\' \\\n  -H "x-mica-owner: $MICA_BROWSER_OWNER" \\\n  -d \'{"url":"https://example.com","label":"登录页"}\''
  },
  {
    id: 'getBrowser',
    method: 'GET',
    path: '/browser/browsers/:id',
    summary: '单个窗口的详情',
    params: [],
    returns: '{ ok, browser }'
  },
  {
    id: 'showBrowser',
    method: 'POST',
    path: '/browser/browsers/:id/show',
    summary:
      '把窗口显示到桌面（唯一会显示窗口的动作）：**只在明确要给用户演示时才调用**，其余操作都不需要它。用户自己想看会点顶栏的浏览器图标',
    params: [
      {
        name: 'focus',
        in: 'query',
        required: false,
        description: 'true 时同时抢焦点；默认 false（演示但不打断用户正在输入的内容）'
      }
    ],
    returns: '{ ok, browser }'
  },
  {
    id: 'hideBrowser',
    method: 'POST',
    path: '/browser/browsers/:id/hide',
    summary: '隐藏窗口但保留页面状态（等价于用户点关闭：只隐藏，不销毁）',
    params: [],
    returns: '{ ok, browser }'
  },
  {
    id: 'closeBrowser',
    method: 'POST',
    path: '/browser/browsers/:id/close',
    summary: '真正销毁窗口（连同它的标签页与页面状态）',
    params: [],
    returns: '{ ok }'
  },
  {
    id: 'listTabs',
    method: 'GET',
    path: '/browser/tabs',
    summary: '列出所有标签页（可只取某个归属的）',
    params: [{ name: 'owner', in: 'query', required: false, description: '只看这个会话的窗口' }],
    returns: '{ ok, tabs: [Tab] }'
  },
  {
    id: 'createTab',
    method: 'POST',
    path: '/browser/tabs',
    summary: '在已有窗口里新开标签页（不给 browserId 就新开一个窗口）',
    params: [
      { name: 'browserId', in: 'body', required: false, description: '目标窗口' },
      { name: 'url', in: 'body', required: false, description: '初始地址' }
    ],
    returns: '{ ok, tab, browser }'
  },
  {
    id: 'activateTab',
    method: 'POST',
    path: '/browser/tabs/:id/activate',
    summary: '切换窗口内的当前标签页',
    params: [],
    returns: '{ ok, browser }'
  },
  {
    id: 'closeTab',
    method: 'POST',
    path: '/browser/tabs/:id/close',
    summary: '关闭标签页（窗口里最后一个标签页被关掉时窗口一起销毁）',
    params: [],
    returns: '{ ok, browser? }'
  },
  {
    id: 'navigate',
    method: 'POST',
    path: '/browser/tabs/:id/navigate',
    summary: '导航：给 url 就去那儿，给 action 就前进/后退/刷新',
    params: [
      {
        name: 'url',
        in: 'body',
        required: false,
        description: '目标地址（没有协议时按 https 补全）'
      },
      {
        name: 'action',
        in: 'body',
        required: false,
        description: 'back / forward / reload（与 url 二选一）'
      }
    ],
    returns: '{ ok, tab }',
    example:
      'curl -s -X POST "$MICA_BROWSER_URL/browser/tabs/$TAB/navigate" -H \'content-type: application/json\' \\\n  -d \'{"url":"github.com"}\''
  },
  {
    id: 'evaluate',
    method: 'POST',
    path: '/browser/tabs/:id/evaluate',
    summary: '在页面主世界执行 JS 并取回结果（读 DOM、取 localStorage 都走它）',
    params: [
      {
        name: 'expression',
        in: 'body',
        required: true,
        description:
          '要执行的表达式（必填，字符串），支持 await；如 "document.title"、"document.body.innerText.slice(0, 200)"'
      },
      { name: 'timeoutMs', in: 'body', required: false, description: '默认 15000' }
    ],
    returns: '{ ok, value }'
  },
  {
    id: 'content',
    method: 'GET',
    path: '/browser/tabs/:id/content',
    summary: '取页面文本（默认 innerText，可要 html）—— 「看看这一页写了什么」',
    params: [
      { name: 'format', in: 'query', required: false, description: 'text（默认）/ html' },
      {
        name: 'maxChars',
        in: 'query',
        required: false,
        description: '默认 200000，超出会截断并标记'
      }
    ],
    returns: '{ ok, url, title, format, content, truncated }'
  },
  {
    id: 'click',
    method: 'POST',
    path: '/browser/tabs/:id/click',
    summary: '点击：给 selector 按元素中心点，或直接给坐标（窗口隐藏着也照常生效，不用先显示）',
    params: [
      { name: 'selector', in: 'body', required: false, description: 'CSS 选择器（与坐标二选一）' },
      { name: 'x', in: 'body', required: false, description: '视口坐标' },
      { name: 'y', in: 'body', required: false, description: '视口坐标' }
    ],
    returns: '{ ok, target, url }'
  },
  {
    id: 'type',
    method: 'POST',
    path: '/browser/tabs/:id/type',
    summary: '输入文本：可先聚焦 selector，可清空，可回车提交（窗口隐藏着也照常生效）',
    params: [
      {
        name: 'selector',
        in: 'body',
        required: false,
        description: '先聚焦的元素，如 "#username"'
      },
      {
        name: 'text',
        in: 'body',
        required: true,
        description: '要输入的内容（必填，字符串），如 "hello@example.com"'
      },
      { name: 'clear', in: 'body', required: false, description: '先清空该元素的值' },
      { name: 'submit', in: 'body', required: false, description: '输入后按 Enter' }
    ],
    returns: '{ ok, value, submitted }（value 是输入后聚焦元素的当前值）'
  },
  {
    id: 'keys',
    method: 'POST',
    path: '/browser/tabs/:id/keys',
    summary: '按键：Enter / Tab / Escape / 方向键 / 单字符（一次按键请用单字符，组合键不支持）',
    params: [
      {
        name: 'keys',
        in: 'body',
        required: true,
        description:
          '按键数组（必填），每项只能是：具名键 Enter / Tab / Escape / Esc / Backspace / Delete / Space / ArrowUp / ArrowDown / ArrowLeft / ArrowRight / PageUp / PageDown / Home / End，或单个可打印字符（"a" / "1" / "/"）。不要写 "KeyB"、"Meta+Shift+B"、press 这类键盘码或组合键；要发快捷键请改用 evaluate 里 dispatchEvent 一个带 ctrlKey / metaKey 的 KeyboardEvent。例：["Enter"]、["ArrowDown","ArrowDown","Enter"]'
      }
    ],
    returns: '{ ok, fired }'
  },
  {
    id: 'scroll',
    method: 'POST',
    path: '/browser/tabs/:id/scroll',
    summary:
      '滚动页面（按像素，正数向下）：优先滚视口中心下的内部可滚容器（弹层、列表），没有就滚整个文档',
    params: [
      {
        name: 'deltaY',
        in: 'body',
        required: true,
        description: '滚动像素（必填，数字），正数向下、负数向上，如 600'
      }
    ],
    returns: '{ ok, scrollY, container, containerScrollTop }（滚到内部容器时 container 是它的标签名）'
  },
  {
    id: 'screenshot',
    method: 'GET',
    path: '/browser/tabs/:id/screenshot',
    // 隐藏窗口也截得到当前帧（前提是主进程挂了 disable-backgrounding-occluded-windows）：
    // 不显示窗口、不闪一下
    summary: '截图，窗口全程隐藏（整页截图传 fullPage=true）',
    params: [
      { name: 'fullPage', in: 'query', required: false, description: 'true 时截整页' },
      {
        name: 'raw',
        in: 'query',
        required: false,
        description: 'true 时直接返回 image/png 字节，否则返回 dataUrl'
      },
      {
        name: 'timeoutMs',
        in: 'query',
        required: false,
        description: '默认 20000；页面忙时超时返回错误而不是一直挂着'
      }
    ],
    returns: '{ ok, dataUrl, bytes }'
  },
  {
    id: 'waitFor',
    method: 'POST',
    path: '/browser/tabs/:id/wait',
    summary:
      '等待条件成立：元素出现 / 文本出现 / 地址匹配；三个条件都不给时等页面加载完成（document.readyState=complete）',
    params: [
      {
        name: 'selector',
        in: 'body',
        required: false,
        description: '等待元素出现（与 text / url / 空条件四选一）'
      },
      { name: 'text', in: 'body', required: false, description: '等待正文包含该文本' },
      { name: 'url', in: 'body', required: false, description: '等待地址包含该片段' },
      { name: 'timeoutMs', in: 'body', required: false, description: '默认 10000' }
    ],
    returns: '{ ok, matched, elapsedMs }'
  },
  {
    id: 'cookies',
    method: 'GET',
    path: '/browser/tabs/:id/cookies',
    summary: '读 cookie（含 HttpOnly；format=header 直接给可用的 Cookie 头）',
    params: [
      { name: 'format', in: 'query', required: false, description: 'json（默认）/ header' },
      {
        name: 'url',
        in: 'query',
        required: false,
        description: '改用它作为作用域，默认取当前页地址'
      }
    ],
    returns: '{ ok, url, count, cookieHeader, cookies }',
    example: 'curl -s "$MICA_BROWSER_URL/browser/tabs/$TAB/cookies?format=header"'
  },
  {
    id: 'cookiesForScope',
    method: 'GET',
    path: '/browser/cookies',
    summary: '按 url 直接读 cookie（不需要标签页），并把结果缓存成固定文件供别的进程复用',
    params: [
      {
        name: 'url',
        in: 'query',
        required: true,
        description: '作用域地址，例如 https://osim108.zuche-saas.osim.intra.xiaojukeji.com/'
      },
      { name: 'format', in: 'query', required: false, description: 'json（默认）/ header' },
      {
        name: 'save',
        in: 'query',
        required: false,
        description:
          '1（默认）时把 Cookie 头与明细写到应用 userData 下的 browser-cookies/（macOS: ~/Library/Application Support/mica-code-app/browser-cookies/），0 时只读不写'
      }
    ],
    returns: '{ ok, url, count, cookieHeader, cookies, saved: { headerPath, jsonPath } }',
    example:
      'curl -s "$MICA_BROWSER_URL/browser/cookies?format=header&url=https%3A%2F%2Fexample.com%2F"'
  },
  {
    id: 'allCookies',
    method: 'GET',
    path: '/browser/cookies/all',
    summary:
      '列分区里的全部 cookie（可只取一个域及其子域）：把浏览器里的登录态搬到别处，或者核对某条 cookie 到底在不在',
    params: [
      {
        name: 'domain',
        in: 'query',
        required: false,
        description: '只列这个域及其子域，例如 xiaojukeji.com；省略则整个分区'
      },
      {
        name: 'limit',
        in: 'query',
        required: false,
        description: '最多返回多少条，默认 2000、上限 20000（超出时 truncated 为 true）'
      }
    ],
    returns: '{ ok, domain, total, count, truncated, cookies }',
    example: 'curl -s "$MICA_BROWSER_URL/browser/cookies/all?domain=xiaojukeji.com"'
  },
  {
    id: 'setCookies',
    method: 'POST',
    path: '/browser/cookies/set',
    summary:
      '批量写入 cookie（按 domain/url 定作用域，写完立刻落盘）：把别处的登录态灌进这个浏览器',
    params: [
      {
        name: 'cookies',
        in: 'body',
        required: true,
        description:
          '数组，每条 { name, value, domain 或 url, path, secure, httpOnly, sameSite, hostOnly, expirationDate }；不带 expirationDate 即会话 cookie'
      }
    ],
    returns: '{ ok, written, failed: [{ name, domain, reason }] }'
  },
  {
    id: 'removeCookies',
    method: 'POST',
    path: '/browser/cookies/remove',
    summary: '按 (domain, path, name) 删 cookie；同名不同 path 的不会被一起删掉',
    params: [
      {
        name: 'cookies',
        in: 'body',
        required: true,
        description: '数组，每条 { name, domain 或 url, path }'
      }
    ],
    returns: '{ ok, removed, failed: [{ name, domain, reason }] }'
  },
  {
    id: 'console',
    method: 'GET',
    path: '/browser/tabs/:id/console',
    summary: '页面控制台消息（从标签页创建起累计，clear=1 读完清空）',
    params: [{ name: 'clear', in: 'query', required: false, description: '1 时清空' }],
    returns: '{ ok, entries: [{ level, message, source, line, at }] }'
  },
  {
    id: 'network',
    method: 'GET',
    path: '/browser/tabs/:id/network',
    summary:
      '网络请求记录（CDP 采集，含 4xx/5xx、请求头 headers、请求体 body、状态码），clear=1 读完清空',
    params: [{ name: 'clear', in: 'query', required: false, description: '1 时清空' }],
    returns:
      '{ ok, entries: [{ method, url, status, resourceType, headers, body, at }] }（headers 是所有非敏感请求头，可用来确认 `nuwa-wings` 这类环境头；body 是 POST 请求体，两者超长都会截断）'
  },
  {
    id: 'events',
    method: 'SSE',
    path: '/browser/events',
    summary: '窗口/标签页变化推送（桌面端运行时订阅它，再广播给页面）',
    params: [],
    returns: 'text/event-stream：{ channel: "browser:changed", payload: { browsers } }'
  }
]

/**
 * 路径参数（`:id`）由 `withPathParams` 补齐：MCP 门面按 `params` 摊到 path 上，
 * 漏声明时 `evaluate` / `screenshot` / `waitFor` 这些按标签页操作的 action 会打到
 * 字面量 `:id` 上，agent 根本没法用。
 */
export const BROWSER_ENDPOINTS = withPathParams(RAW_ENDPOINTS, (name, endpoint) => {
  // 路径参数是「猜参数」的重灾区：模型手上往往只有一个地址，不知道 id 从哪来、长什么样。
  const windowScoped = String(endpoint.path).startsWith('/browser/browsers/')
  const kind = windowScoped ? '窗口' : '标签页'
  const source = windowScoped
    ? 'listBrowsers → browsers[].id'
    : 'listTabs → tabs[].id 或 createTab 的返回'
  const sample = windowScoped ? 'brw-1' : 'tab-1'
  return `${name} 是${kind} id（取自 ${source}，形如 "${sample}"），不是选择器、标题或地址`
})

const byId = new Map(BROWSER_ENDPOINTS.map((endpoint) => [endpoint.id, endpoint]))

export function endpointById(id) {
  return byId.get(id) || null
}

export function capabilityCatalog() {
  return BROWSER_ENDPOINTS.map((endpoint) => ({
    id: endpoint.id,
    method: endpoint.method,
    path: endpoint.path,
    summary: endpoint.summary
  }))
}

function paramLabel(param) {
  return `${param.name}（${param.in}${param.required ? '，必填' : ''}）`
}

/**
 * 给 agent 的短提示：MCP tool 返回的 doc 列表里带这段，比让模型翻整份 markdown 更省上下文。
 * 详细文档仍然由 `buildDocsMarkdown` 生成（`/browser/docs` 与设置页用）。
 */
export const BROWSER_GUIDE = [
  '第一次用某个动作前，先不带 action 调用 control：返回的 actions[] 里每个动作都带 params（name / 类型 / 是否必填 / 示例值），一次就能看全，比猜参数名快。',
  '先 listBrowsers 看有没有窗口；没有就 createBrowser（默认隐藏创建，不打断用户）。',
  '窗口全程保持隐藏：截图、点击、输入、按键、滚动、读页面/cookie/console/network 都在隐藏状态下完成，**不需要先 showBrowser**。显示窗口会让用户眼前弹一个窗，只在用户明确要求「演示给我看」时才调它。',
  '用户会自己点顶栏那枚浏览器图标唤出窗口查看（也能再点一次收起），这件事不要替用户做；你只需要保证页面状态是对的。',
  'action 名必须与 actions[].action 完全一致（区分大小写），不要自己起同义词：按键是 keys（不是 press / key / keyboard），点击是 click，读页面是 content 或 evaluate。按标签页/窗口的动作都要带 id：标签页 id 形如 "tab-1"、窗口 id 形如 "brw-1"，取自 listTabs / listBrowsers / createTab 的返回。',
  '缺必填参数会被直接回绝：evaluate 要 expression、type 要 text、keys 要 keys、scroll 要 deltaY，其余看 actions[].params 里的 required。',
  'keys 只接受单个键：Enter / Tab / Escape / Esc / Backspace / Delete / Space / ArrowUp / ArrowDown / ArrowLeft / ArrowRight / PageUp / PageDown / Home / End，或单个可打印字符（"a"、"1"、"/"）。组合键（Cmd / Ctrl / Shift / Alt）不支持，也不要写 KeyB 这类键盘码：要按 Ctrl+S 这种快捷键，改用 evaluate 在页面里 dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, bubbles: true }))，或者直接点页面上那个按钮。',
  '等页面别 sleep：用 waitFor（不给条件 = 等加载完成，也可等元素/文本/地址）。',
  '读页面优先 content / evaluate；不要 hook fetch —— 要核对请求参数看 network 记录里的 body 与 headers。',
  '截图超时（页面忙、长任务）先重试；仍失败就改用 evaluate 读 DOM / content 校验收敛。',
  'evaluate 里的复杂逻辑写成 (async () => { … })()，它会等待 Promise。',
  '用户关窗口只是隐藏（页面状态保留）；hideBrowser 同理，closeBrowser 才真正销毁。'
].join('\n')

/**
 * 「未知操作」时给最接近的合法 action 名。
 *
 * 端点有 20 多条，模型凭印象写 `press` / `readContent` / `goto` 时，只回一句可用清单等于让它
 * 在 20 个名字里再猜一次；给出编辑距离最近的几个，通常一眼就能认出该用哪个。
 * 纯字符串计算，不做 IO，也不猜语义。
 */
export function suggestActionIds(input, ids = BROWSER_ENDPOINTS.map((endpoint) => endpoint.id)) {
  const target = normalizeActionName(input)
  if (!target) return []
  const byNormalized = new Map(ids.map((id) => [normalizeActionName(id), id]))

  // 大小写/连字符写错（`listbrowsers`、`list-tabs`）先按归一化名认回来
  const exact = byNormalized.get(target)
  if (exact) return [exact]

  // 同义词：`press` 与 `keys` 的编辑距离太远，只能靠这张小表
  const alias = ACTION_ALIASES[target]
  if (alias && byNormalized.has(normalizeActionName(alias))) {
    return [byNormalized.get(normalizeActionName(alias))]
  }

  const scored = []
  for (const id of ids) {
    const candidate = id.toLowerCase()
    const distance = editDistance(target, candidate)
    const prefix = candidate.startsWith(target) || target.startsWith(candidate)
    // 只有「差一两个字母」才算相近：阈值放宽到 1/3 长度会让 `nope` 命中 `type`
    const limit = Math.max(1, Math.floor(candidate.length / 3))
    if (!prefix && distance > limit) continue
    scored.push({ id, score: prefix ? Math.min(distance, 1) : distance })
  }
  scored.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))
  return scored.slice(0, MAX_ACTION_SUGGESTIONS).map((item) => item.id)
}

function normalizeActionName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

function editDistance(left, right) {
  if (left === right) return 0
  let previous = [...Array(right.length + 1).keys()]
  for (let i = 1; i <= left.length; i++) {
    const current = [i]
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
    }
    previous = current
  }
  return previous[right.length]
}

export function buildDocsMarkdown({ serviceUrl = '$MICA_BROWSER_URL' } = {}) {
  const lines = [
    '# 受控浏览器（Mica 桌面端内置）',
    '',
    '这是 Mica 桌面应用自己托管的浏览器：窗口由 Mica 创建、由 AI 通过 HTTP 驱动，',
    '地址栏不可编辑，用户关窗口只是隐藏（页面状态保留）。',
    '',
    '窗口默认**全程隐藏**：AI 的截图、点击、输入、按键、滚动都在隐藏窗口里完成，不会在用户',
    '眼前弹窗；`showBrowser` 是唯一会显示窗口的动作，只在明确要给用户演示时使用。用户自己',
    '点顶栏的浏览器图标就能唤出窗口查看。',
    '',
    `服务地址：\`${serviceUrl}\``,
    '',
    '新建窗口**必须**带 `x-mica-owner: $MICA_BROWSER_OWNER`：顶栏只显示本会话自己的窗口，没有归属的窗口会被直接关闭（缺这个头时新建返回 400）。',
    '',
    '## 通过 MCP 的 control 工具调用',
    '',
    '`control({ action: "evaluate", params: { id: "tab-1", expression: "document.title" } })` ——',
    '`action` 就是下面每个端点的 id（区分大小写），`params` 的键名与端点参数同名。',
    '不带 `action` 调用一次会返回全部动作与参数说明（含必填标记），不知道参数时先这么读一遍。',
    '',
    '## 使用提示（踩过的坑）',
    '',
    ...BROWSER_GUIDE.split('\n').map((line) => `- ${line}`),
    '- 服务探活：`GET /browser/health` 返回 503 说明 Mica Code 应用（主进程）没在提供服务，',
    '  重启应用可恢复；纯 `npm run start:web` 的宿主没有这个能力。',
    '',
    '## 端点',
    ''
  ]
  for (const endpoint of BROWSER_ENDPOINTS) {
    lines.push(`### ${endpoint.method} ${endpoint.path}`)
    lines.push('')
    lines.push(endpoint.summary)
    const required = (endpoint.params || [])
      .filter((param) => param.required)
      .map((param) => param.name)
    if (required.length > 0) {
      lines.push('')
      lines.push(`必填参数：${required.join('、')}`)
    }
    if (endpoint.params?.length) {
      lines.push('')
      for (const param of endpoint.params)
        lines.push(`- ${paramLabel(param)}：${param.description}`)
    }
    if (endpoint.returns) {
      lines.push('')
      lines.push(`返回：\`${endpoint.returns}\``)
    }
    if (endpoint.example) {
      lines.push('')
      lines.push('```bash')
      lines.push(endpoint.example)
      lines.push('```')
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

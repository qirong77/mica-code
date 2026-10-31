import { isElectronShell } from './shell-env'

/**
 * 插件的前端模块能用的宿主能力。
 *
 * 插件卡片跑在页面里，但它需要的东西有一半在运行时那边：探活某个地址、读写自己的数据
 * 文件（页面没有文件系统）。这份 API 就是那层封口——插件只认它，不认 `window.mica`，
 * 宿主换实现时插件不用改。
 *
 * `open` 反过来是纯页面能力：打开另一个运行时就是一次 `location.assign`，外壳接管它
 * 并弹出新窗口（见 src/main/index.js 的 will-navigate），浏览器里开新标签页。
 *
 * `action` 是「卡片要真的干一件事」：刷新一批数据、试连一次接口。页面里没有插件自己的
 * 代码，所以只能按清单里声明过的 key 请宿主去跑——执行它的是 `mica plugin-action`，
 * 与配置页点按钮同一条路，同样不需要打开会话。
 */

/** 当前页面所在的运行时：页面就是它托管的，所以 origin 即地址。 */
export function currentRuntimeAddress() {
  return String(window.location?.origin || '')
}

/**
 * 打开另一个运行时的地址。
 *
 * 外壳里交给主进程：`location.assign` 触发的导航会被 `will-navigate` 接管，改成弹出新
 * 窗口、本窗口不动。浏览器里开新标签页，被弹窗拦截时退回本标签页。依赖可注入，便于单测。
 */
export function openRuntimeTarget(url, { userAgent, open, assign } = {}) {
  const agent = userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent)
  const navigate = assign ?? ((target) => window.location.assign(target))

  if (isElectronShell(agent)) {
    navigate(url)
    return 'window'
  }

  const spawnTab = open ?? ((target) => window.open(target, '_blank'))
  const spawned = spawnTab(url)
  if (spawned) {
    // 不用 window.open 的 `noopener` 特性串：它会让 window.open 恒返回 null，弹窗被
    // 拦截时就分辨不出来、退路也没了；直接在拿到的窗口上掐掉 opener 等价。
    try {
      spawned.opener = null
    } catch {
      // 某些浏览器不让写，忽略
    }
    return 'tab'
  }
  navigate(url)
  return 'same-tab'
}

/**
 * 交给插件 `desktop.jsx` 的那份 api。`pluginId` 由宿主注入，插件不必自己拼——它也
 * 拼不对：数据文件按插件 id 落在 `$MICA_HOME/plugin-data/<id>/data.json`。
 */
export function createPluginHostApi(pluginId) {
  const host = window.mica?.pluginHost
  return {
    pluginId,
    currentHost: () => currentRuntimeAddress(),
    /** 这个地址上是不是一台 Mica 运行时：跨源探测页面做不了，由运行时代查。 */
    probe: (address) => host.probe(String(address ?? '')),
    /** 插件自己的数据及内容版本。写入时可带 expectedVersion，冲突后重读并重放修改。 */
    readData: () => host.readData(pluginId),
    writeData: (value, options) => host.writeData(pluginId, value, options),
    /**
     * 运行时的远程访问策略：别的机器要进这台机器时要不要口令、口令是什么、别人从哪个
     * 地址进来（`addresses`）。这是宿主自己的能力，不是插件的私有数据——请求分派用的是
     * 同一份，所以界面显示和实际生效不会分叉。
     */
    access: {
      get: () => host.access(),
      set: (patch) => host.setAccess(patch)
    },
    /** 打开另一个运行时：外壳里开新窗口，浏览器里开新标签页。 */
    open: (url) => openRuntimeTarget(url),
    /**
     * 执行清单里声明过的一个动作（`plugin.json` 的 `actions[].key`）。
     *
     * 结果是 `{ ok, message?, link?, error? }`：失败不抛异常，卡片上一行红字比一个没人接
     * 的 rejected promise 有用。没声明的 key 会被拒绝——页面上本来就没有那个按钮。
     */
    action: (key) => host.runAction(pluginId, String(key ?? ''))
  }
}

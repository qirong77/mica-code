/**
 * 系统检查服务的端点目录。**唯一事实来源**：服务的路由表由它编译，不会出现
 * 「文档写了但路由没实现」的漂移（与 terminal-docs.js / browser-docs.js 同一套约定）。
 *
 * 这个服务只有运行时自己用（见 src/host/system-checks.js），所以端点刻意很少：
 * 读状态、打开设置面板。面板取值只认清单里声明过的 `pane`，服务不接受别的 URL。
 */

import { allowedPanels, promptableChecks } from './system-core.js'

const RAW_ENDPOINTS = [
  {
    id: 'launcherControl', method: 'POST', path: '/plugin-launcher',
    summary: '控制清单声明的桌面启动器；启停由外壳校验',
    params: [
      { name: 'pluginId', in: 'body', required: true, description: '随包插件 id' },
      { name: 'action', in: 'body', required: true, description: 'status / show / close / retry / configure / openPath' },
      { name: 'path', in: 'body', required: false, description: 'openPath 要打开的绝对路径' }
    ],
    returns: 'status 返回 { shortcut, registered, error }；其它动作返回 {}'
  },
  {
    id: 'checks',
    method: 'GET',
    path: '/checks',
    summary: '读本机的权限与命令行工具状态',
    params: [],
    returns:
      '{ platform, checks: [{ id, label, description, pane?, status, detail }] }，status 取值 granted / denied / unknown'
  },
  {
    id: 'openSettings',
    method: 'POST',
    path: '/open-settings',
    summary: '打开某一项检查对应的系统设置面板（只接受清单里声明过的 pane）',
    params: [
      {
        name: 'pane',
        in: 'body',
        required: true,
        description: `系统设置面板 URL，只接受清单声明过的取值：${allowedPanels().join(' / ')}`
      }
    ],
    returns: '{ pane }'
  },
  {
    id: 'requestAccess',
    method: 'POST',
    path: '/request-access',
    summary: '让系统把当前这个构建登记进权限列表（辅助功能），然后等用户勾选',
    params: [
      {
        name: 'id',
        in: 'body',
        required: true,
        description: `可主动请求的检查项：${promptableChecks().join(' / ')}`
      }
    ],
    returns: '{ id, granted }，granted 是调用那一刻的状态（通常仍是 false，勾选要用户做）'
  },
  {
    id: 'heapSnapshot',
    method: 'POST',
    path: '/heap-snapshot',
    summary: '给某个页面拍一份 V8 堆快照并落到日志目录（Performance 页「抓堆快照」用）',
    params: [
      {
        name: 'windowId',
        in: 'body',
        required: false,
        description: '目标窗口 id；不给就取聚焦的那个，再不行取第一个应用窗口'
      }
    ],
    returns: '{ path, bytes, windowId, title }。快照期间目标页面会停住几秒，文件可能上百 MB'
  }
]

export const SYSTEM_ENDPOINTS = RAW_ENDPOINTS

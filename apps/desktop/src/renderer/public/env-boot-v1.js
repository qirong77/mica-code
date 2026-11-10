// 此文件名是启动协议版本：内容变更时新增版本文件并更新 HTML 和 transport；旧版本须保留兼容。
;(function startEnvRequest() {
  if (window.__micaEnvBootV1 || window.mica) return
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return
  if (new URLSearchParams(location.search).get('quick-buttons-demo') === '1') return

  // 即使主模块还没加载，失败也立即被接住；由 transport 原样处理状态和异常。
  var result
  try {
    result = fetch('/api/env', { cache: 'no-store' }).then(
      function (response) {
        return { response: response }
      },
      function (error) {
        return { error: error, failed: true }
      }
    )
  } catch (error) {
    result = Promise.resolve({ error: error, failed: true })
  }
  window.__micaEnvBootV1 = { result: result }
})()

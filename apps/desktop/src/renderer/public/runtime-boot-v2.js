// Versioned URL so cached HTML assets cannot claim requests from another boot protocol.
;(function startRuntimeRequests() {
  if (window.__micaRuntimeBootV2 || window.mica) return
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return
  if (new URLSearchParams(location.search).get('quick-buttons-demo') === '1') return

  // 即使主模块还没加载，失败也立即被接住；由 transport 原样处理状态和异常。
  function fetchEarly(url, options) {
    try {
      return fetch(url, options).then(
        function (response) { return { response: response } },
        function (error) { return { error: error, failed: true } }
      )
    } catch (error) {
      return Promise.resolve({ error: error, failed: true })
    }
  }
  window.__micaRuntimeBootV2 = {
    env: fetchEarly('/api/env', { cache: 'no-store' }),
    uiState: fetchEarly('/api/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"channel":"ui-state:get"}'
    })
  }
})()

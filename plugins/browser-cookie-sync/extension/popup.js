const BASE = 'http://127.0.0.1:19387';
const RECONNECT = 'mica-cookie-sync/reconnect';
const SYNC_NOW = 'mica-cookie-sync/sync-now';

const lamp = document.getElementById('lamp');
const statusText = document.getElementById('status');
const meta = document.getElementById('meta');
const foot = document.getElementById('foot');
const syncButton = document.getElementById('sync');
const retryButton = document.getElementById('retry');
const input = document.getElementById('token');
const form = document.getElementById('token-form');
const toggle = document.getElementById('toggle');
const toggleLabel = document.getElementById('toggle-label');

function setState(tone, html) {
  lamp.dataset.tone = tone;
  statusText.innerHTML = html;
}

function setFoot(text, tone) {
  foot.textContent = text;
  foot.classList.toggle('is-danger', tone === 'danger');
}

function formatTime(at) {
  const at_ = new Date(at);
  const today = new Date();
  const sameDay =
    at_.getFullYear() === today.getFullYear() &&
    at_.getMonth() === today.getMonth() &&
    at_.getDate() === today.getDate();
  return sameDay
    ? at_.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : at_.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function ownBuild() {
  try {
    const response = await fetch(chrome.runtime.getURL('version.json'), { cache: 'no-store' });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/**
 * 版本行：显示当前运行的扩展版本与「磁盘上的代码最近一次被 Mica 更新」的时间。
 * 两者指纹不一致时说明 Mica 已经写入了新版、但 Chrome 还在跑旧代码，
 * 这时把更新时间换成一个重载按钮（service worker 也会自动重载，这里只是手动出口）。
 */
async function renderVersion(serverInfo) {
  const [own, stored] = await Promise.all([ownBuild(), chrome.storage.local.get('extensionInfo')]);
  // 优先用这次探测拿到的服务端信息：它比 storage 里 worker 记下的那次更新。
  const extensionInfo = serverInfo ?? stored?.extensionInfo;
  const running = chrome.runtime.getManifest().version ?? own?.version ?? '?';
  if (!extensionInfo || typeof extensionInfo.updatedAt !== 'number') {
    meta.textContent = `扩展 v${running}`;
    return;
  }
  if (own && extensionInfo.fingerprint !== own.fingerprint) {
    meta.innerHTML = `<span>扩展 v${running}，磁盘上是 v${extensionInfo.version}</span>`;
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.textContent = '立即重载';
    reload.addEventListener('click', () => chrome.runtime.reload());
    meta.append(reload);
    return;
  }
  meta.textContent = `扩展 v${running} · 上次更新 ${formatTime(extensionInfo.updatedAt)}`;
}

function formatStats(stats) {
  const parts = [`比对 ${stats.compared} 条`];
  if (stats.toChrome) parts.push(`写入 Chrome ${stats.toChrome} 条`);
  if (stats.toMica) parts.push(`写入 Mica ${stats.toMica} 条`);
  if (stats.skipped) parts.push(`冲突跳过 ${stats.skipped} 条`);
  if (stats.failed) parts.push(`失败 ${stats.failed} 条`);
  return parts.join(' · ');
}

async function currentToken() {
  const { token } = await chrome.storage.local.get('token');
  return typeof token === 'string' ? token.trim() : '';
}

async function probe(token) {
  let response;
  try {
    response = await fetch(`${BASE}/health`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    return { tone: 'error', text: '连不上 Mica：确认 Mica 在运行、这个扩展已启用' };
  }
  if (response.status === 401) return { tone: 'error', text: '口令不正确，重新从 Mica 复制一次' };
  if (!response.ok) return { tone: 'error', text: `本机服务返回 ${response.status}` };
  const body = await response.json().catch(() => null);
  if (!body || typeof body.connected !== 'boolean') return { tone: 'error', text: '本机服务响应异常' };
  return body.connected
    ? { tone: 'ok', text: '<b>已连接</b>，改动会实时双向同步', extension: body.extension }
    : { tone: 'warn', text: 'Mica 在运行，扩展还没连上，点「重新连接」', extension: body.extension };
}

async function showLastSync() {
  const { lastSync } = await chrome.storage.local.get('lastSync');
  if (!lastSync || typeof lastSync.at !== 'number') {
    setFoot('还没有同步记录');
    return;
  }
  setFoot(`最近同步 ${formatTime(lastSync.at)} · ${formatStats(lastSync)}`);
}

async function refresh() {
  const token = await currentToken();
  if (!token) {
    setState('warn', '还没填口令：从 Mica 的插件设置页复制，展开下面填进来');
    revealTokenForm(true);
    syncButton.disabled = true;
    setFoot('');
    return;
  }
  syncButton.disabled = false;
  const result = await probe(token);
  setState(result.tone, result.text);
  await renderVersion(result.extension);
  await showLastSync();
}

function revealTokenForm(open) {
  form.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  toggleLabel.textContent = open ? '收起' : '修改连接口令';
  if (open) input.focus();
}

async function withBusy(button, label, job) {
  const original = button.textContent;
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span>${label}`;
  try {
    return await job();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

toggle.addEventListener('click', () => revealTokenForm(form.hidden));

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = input.value.trim();
  if (!token) return;
  await chrome.storage.local.set({ token });
  revealTokenForm(false);
  setState('idle', '口令已保存，正在连接…');
  setTimeout(refresh, 1200);
});

retryButton.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: RECONNECT }).catch(() => {});
  setState('idle', '正在重新连接…');
  setTimeout(refresh, 1200);
});

syncButton.addEventListener('click', async () => {
  setFoot('正在和 Mica 比对全部 cookie…');
  const result = await withBusy(syncButton, '同步中', () =>
    chrome.runtime.sendMessage({ type: SYNC_NOW }).catch((error) => ({ ok: false, message: String(error) })),
  );
  if (!result || !result.ok) {
    const reason = result?.reason === 'no-token' ? '还没填口令' : result?.message || result?.reason || '未知原因';
    setFoot(`同步失败：${reason}`, 'danger');
    return;
  }
  const { stats } = result;
  setFoot(`刚刚同步 · ${formatStats(stats)}`);
  // 同步会推进连接状态，重新探一次再显示。
  const token = await currentToken();
  if (token) {
    const probeResult = await probe(token);
    setState(probeResult.tone, probeResult.text);
    await renderVersion(probeResult.extension);
  }
});

chrome.storage.local
  .get('token')
  .then(({ token }) => {
    if (typeof token === 'string') input.value = token;
  })
  .catch(() => setFoot('读取本地口令失败', 'danger'));

void refresh();

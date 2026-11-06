const BASE = 'http://127.0.0.1:19387';
const ALARM = 'mica-cookie-reconnect';
const ECHO_MS = 5000;
const RECONNECT = 'mica-cookie-sync/reconnect';
const SYNC_NOW = 'mica-cookie-sync/sync-now';
/** 同一个目标指纹被重载过一次后，在这段时间内不再重试，防止版本对不上时来回重载。 */
const RELOAD_BACKOFF_MS = 10 * 60_000;
let connection;
let controller;
let chain = Promise.resolve();
let snapshotRevision = -1;
let ownBuild;
const localRevisions = new Map();
const echoes = new Map();

function serialize(job) {
  const result = chain.then(job);
  chain = result.catch((error) => console.warn('Mica cookie sync:', error.message));
  return result;
}

function normalize(cookie) {
  if (
    !cookie ||
    cookie.partitionKey ||
    (cookie.storeId && cookie.storeId !== '0') ||
    typeof cookie.name !== 'string' ||
    typeof cookie.value !== 'string'
  )
    return null;
  const host = String(cookie.host ?? cookie.domain ?? '')
    .replace(/^\.+/, '')
    .toLowerCase();
  if (!host || !cookie.name) return null;
  return {
    host,
    hostOnly: Boolean(cookie.hostOnly),
    name: cookie.name,
    path: cookie.path || '/',
    value: cookie.value,
    expiresAt:
      cookie.expiresAt !== undefined ? cookie.expiresAt : cookie.session ? null : (cookie.expirationDate ?? null),
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: cookie.sameSite || 'unspecified',
  };
}

function key(cookie) {
  return JSON.stringify([cookie.host, cookie.hostOnly, cookie.path, cookie.name]);
}

async function fingerprint(cookie) {
  if (!cookie) return null;
  const body = JSON.stringify([
    cookie.value,
    cookie.expiresAt === null ? null : Math.round(cookie.expiresAt),
    cookie.secure,
    cookie.httpOnly,
    cookie.sameSite,
    cookie.hostOnly,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function echoKey(cookie, removed) {
  return `${key(cookie)}:${removed ? 'removed' : 'set'}`;
}

function expectEcho(cookie, removed) {
  const id = echoKey(cookie, removed);
  const entries = echoes.get(id) || [];
  entries.push({ cookie, until: Date.now() + ECHO_MS });
  echoes.set(id, entries);
}

function consumeEcho(cookie, removed) {
  const id = echoKey(cookie, removed);
  const entries = (echoes.get(id) || []).filter((entry) => entry.until > Date.now());
  const index = entries.findIndex(
    ({ cookie: expected }) =>
      removed ||
      (expected.value === cookie.value &&
        expected.secure === cookie.secure &&
        expected.httpOnly === cookie.httpOnly &&
        expected.sameSite === cookie.sameSite &&
        expected.hostOnly === cookie.hostOnly &&
        (expected.expiresAt === null
          ? cookie.expiresAt === null
          : Math.abs(expected.expiresAt - cookie.expiresAt) < 2)),
  );
  if (index >= 0) entries.splice(index, 1);
  if (entries.length) echoes.set(id, entries);
  else echoes.delete(id);
  return index >= 0;
}

async function request(path, token, init = {}, timeoutMs = 15000) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
    signal: timeout,
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Local service returned ${response.status}`);
  return response;
}

async function currentToken() {
  const { token } = await chrome.storage.local.get('token');
  return typeof token === 'string' ? token.trim() : '';
}

/** 自己这份代码的版本与指纹（由生成脚本写进 version.json）。 */
async function ownVersion() {
  if (ownBuild) return ownBuild;
  try {
    const response = await fetch(chrome.runtime.getURL('version.json'), { cache: 'no-store' });
    if (!response.ok) return null;
    const build = await response.json();
    if (typeof build?.fingerprint !== 'string') return null;
    ownBuild = build;
    return build;
  } catch {
    return null;
  }
}

/**
 * 自动更新：Mica 升级后会把新的扩展文件写到磁盘并记下新指纹。这里比对一下，
 * 不一致就重载扩展本身（chrome.runtime.reload 会重新从目录读取 manifest 与代码），
 * 用户不需要再去 chrome://extensions 手动「重新加载」。
 */
async function checkVersion(token) {
  let health;
  try {
    const response = await fetch(`${BASE}/health`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return;
    health = await response.json();
  } catch {
    return;
  }
  const remote = health?.extension;
  if (!remote || typeof remote.fingerprint !== 'string' || typeof remote.updatedAt !== 'number') return;
  const own = await ownVersion();
  // 服务端还没升级到带版本信息的那版：只记录，不据此重载。
  await chrome.storage.local.set({ extensionInfo: { ...remote, checkedAt: Date.now(), current: own?.version ?? null } });
  if (!own || own.fingerprint === remote.fingerprint) return;
  // 同一个目标指纹连续重载仍对不上（例如用户加载的是手工拷贝的目录），退避时间翻倍，
  // 上限一天——不能因为一次误判就每分钟重载一次。
  const { reloadGuard } = await chrome.storage.local.get('reloadGuard');
  const attempts = reloadGuard?.fingerprint === remote.fingerprint ? (reloadGuard.attempts ?? 1) : 0;
  const wait = Math.min(RELOAD_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), 24 * 3600_000);
  if (attempts > 0 && typeof reloadGuard.at === 'number' && Date.now() - reloadGuard.at < wait) return;
  await chrome.storage.local.set({
    reloadGuard: { fingerprint: remote.fingerprint, at: Date.now(), attempts: attempts + 1 },
  });
  await chrome.storage.local.set({ lastUpdate: { from: own.version, to: remote.version, at: Date.now() } });
  console.info('Mica cookie sync: reloading extension to', remote.version);
  chrome.runtime.reload();
}

async function post(cookie, removed, token) {
  const response = await request('/events', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookie, removed }),
  });
  const result = await response.json();
  if (Number.isSafeInteger(result.revision)) localRevisions.set(key(cookie), result.revision);
}

function cookieUrl(cookie) {
  return `https://${cookie.host}${cookie.path}`;
}

async function applyToChrome(cookie, removed) {
  const matches = (await chrome.cookies.getAll({ domain: cookie.host, name: cookie.name })).filter(
    (item) =>
      !item.partitionKey &&
      item.storeId === '0' &&
      item.domain.replace(/^\.+/, '').toLowerCase() === cookie.host &&
      item.path === cookie.path &&
      item.hostOnly === cookie.hostOnly,
  );
  if (removed) {
    if (!matches.length) return;
    expectEcho(cookie, true);
    // URL/name removal can select an older same-name cookie from a parent domain.
    await chrome.cookies.set({
      url: cookieUrl(cookie),
      name: cookie.name,
      value: '',
      path: cookie.path,
      secure: matches[0].secure,
      httpOnly: matches[0].httpOnly,
      expirationDate: 1,
      storeId: '0',
      ...(cookie.hostOnly ? {} : { domain: `.${cookie.host}` }),
    });
    const remaining = await chrome.cookies.getAll({ domain: cookie.host, name: cookie.name });
    if (
      remaining.some(
        (item) =>
          !item.partitionKey &&
          item.storeId === '0' &&
          item.domain.replace(/^\.+/, '').toLowerCase() === cookie.host &&
          item.path === cookie.path &&
          item.hostOnly === cookie.hostOnly,
      )
    ) {
      throw new Error('Chrome could not remove a cookie');
    }
    return;
  }
  if (matches.length && (await fingerprint(normalize(matches[0]))) === (await fingerprint(cookie))) return;
  expectEcho(cookie, false);
  const details = {
    url: cookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.hostOnly ? {} : { domain: `.${cookie.host}` }),
    ...(cookie.sameSite === 'unspecified' ? {} : { sameSite: cookie.sameSite }),
    ...(cookie.expiresAt === null ? {} : { expirationDate: cookie.expiresAt }),
  };
  if (!(await chrome.cookies.set({ ...details, storeId: '0' }))) throw new Error('Chrome could not set a cookie');
}

async function updateBaseline(cookie, removed) {
  const { baseline = {} } = await chrome.storage.local.get('baseline');
  if (removed) delete baseline[key(cookie)];
  else baseline[key(cookie)] = await fingerprint(cookie);
  await chrome.storage.local.set({ baseline });
}

async function reconcile(token) {
  const response = await request('/snapshot', token, {}, 60000);
  const snapshot = await response.json();
  snapshotRevision = Number.isSafeInteger(snapshot.revision) ? snapshot.revision : -1;
  localRevisions.clear();
  if (!Array.isArray(snapshot.cookies)) throw new Error('Invalid local snapshot');
  const chromeCookies = (await chrome.cookies.getAll({})).map(normalize).filter(Boolean);
  const chromeMap = new Map(chromeCookies.map((cookie) => [key(cookie), cookie]));
  const micaMap = new Map(
    snapshot.cookies
      .map(normalize)
      .filter(Boolean)
      .map((cookie) => [key(cookie), cookie]),
  );
  const { baseline: stored = {} } = await chrome.storage.local.get('baseline');
  const baseline = { ...stored };
  const stats = { compared: 0, toChrome: 0, toMica: 0, skipped: 0, failed: 0 };
  for (const id of new Set([...chromeMap.keys(), ...micaMap.keys(), ...Object.keys(baseline)])) {
    stats.compared += 1;
    // 单条写失败（例如 Mica 侧拒绝某条 cookie）不能中断整轮：否则它后面所有 cookie
    // 都不会再同步，而下一轮又在同一条上失败，永久卡住。
    try {
      const local = chromeMap.get(id);
      const remote = micaMap.get(id);
      const localHash = await fingerprint(local);
      const remoteHash = await fingerprint(remote);
      if (localHash === remoteHash) {
        if (local) baseline[id] = localHash;
        else delete baseline[id];
        continue;
      }
      const previous = baseline[id];
      if (!previous && local && remote) {
        stats.skipped += 1;
        continue;
      }
      if (previous && localHash !== previous && remoteHash !== previous && localHash !== remoteHash) {
        stats.skipped += 1;
        continue;
      }
      const micaWins = (!local && !previous) || (previous && localHash === previous && remoteHash !== previous);
      if (micaWins) {
        await applyToChrome(remote || local, !remote);
        if (remote) baseline[id] = remoteHash;
        else delete baseline[id];
        stats.toChrome += 1;
      } else {
        await post(local || remote, !local, token);
        if (local) baseline[id] = localHash;
        else delete baseline[id];
        stats.toMica += 1;
      }
    } catch (error) {
      stats.failed += 1;
      console.warn('Mica cookie sync:', error.message);
    }
  }
  await chrome.storage.local.set({ baseline, lastSync: { at: Date.now(), ...stats } });
  return stats;
}

async function incoming(event) {
  const cookie = normalize(event?.cookie);
  if (!cookie || typeof event.removed !== 'boolean') return;
  if (
    Number.isSafeInteger(event.revision) &&
    event.revision <= Math.max(snapshotRevision, localRevisions.get(key(cookie)) ?? -1)
  )
    return;
  await applyToChrome(cookie, event.removed);
  await updateBaseline(cookie, event.removed);
  if (Number.isSafeInteger(event.revision)) localRevisions.set(key(cookie), event.revision);
}

async function readEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error('Local event stream ended');
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 1_000_000) throw new Error('Local event stream exceeded size limit');
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        if (!line) {
          if (data.length) {
            const event = JSON.parse(data.join('\n'));
            data = [];
            await serialize(() => incoming(event));
          }
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).trimStart());
        } else if (/^:\s*ping\s*$/.test(line)) {
          await chrome.storage.local.get('token');
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function connect() {
  if (connection) return connection;
  connection = (async () => {
    const activeController = new AbortController();
    controller = activeController;
    let response;
    try {
      const token = await currentToken();
      if (!token || activeController.signal.aborted) return;
      response = await fetch(`${BASE}/events`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        cache: 'no-store',
        signal: activeController.signal,
      });
      if (!response.ok || !response.body) throw new Error(`Local event stream returned ${response.status}`);
      await serialize(() => reconcile(token));
      await readEvents(response);
    } finally {
      activeController.abort();
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  })()
    .catch((error) => {
      if (error.name !== 'AbortError') console.warn('Mica cookie sync:', error.message);
    })
    .finally(() => {
      connection = null;
      controller = null;
    });
  return connection;
}

chrome.cookies.onChanged.addListener(({ cookie, removed, cause }) => {
  if (cause === 'overwrite') return;
  const normalized = normalize(cookie);
  if (!normalized || consumeEcho(normalized, removed)) return;
  serialize(async () => {
    const token = await currentToken();
    if (!token) return;
    try {
      await post(normalized, removed, token);
      await updateBaseline(normalized, removed);
    } catch (error) {
      controller?.abort();
      throw error;
    }
  });
});

chrome.alarms.create(ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM) return;
  void connect();
  void checkVersionWithCurrentToken();
});
chrome.runtime.onStartup.addListener(() => {
  void connect();
  void checkVersionWithCurrentToken();
});
chrome.runtime.onInstalled.addListener(() => {
  void connect();
  void checkVersionWithCurrentToken();
});

async function checkVersionWithCurrentToken() {
  const token = await currentToken();
  if (token) await checkVersion(token);
}

function restart() {
  controller?.abort();
  if (connection) connection.finally(() => connect());
  else void connect();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.token) return;
  restart();
});
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (!message) return;
  if (message.type === RECONNECT) {
    restart();
    void checkVersionWithCurrentToken();
    respond({ ok: true });
    return;
  }
  if (message.type !== SYNC_NOW) return;
  // 返回 true 表示这个通道要异步回复。
  (async () => {
    const token = await currentToken();
    if (!token) {
      respond({ ok: false, reason: 'no-token' });
      return;
    }
    try {
      // 走同一条串行链，避免和定时重连的比对交错写。
      respond({ ok: true, stats: await serialize(() => reconcile(token)) });
    } catch (error) {
      respond({ ok: false, reason: 'error', message: error.message });
    }
  })();
  return true;
});
void connect();

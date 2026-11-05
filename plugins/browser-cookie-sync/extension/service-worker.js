const BASE = 'http://127.0.0.1:19387';
const ALARM = 'mica-cookie-reconnect';
const ECHO_MS = 5000;
let connection;
let controller;
let chain = Promise.resolve();
let snapshotRevision = -1;
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

async function request(path, token, init = {}) {
  const timeout = AbortSignal.timeout(15000);
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
  const response = await request('/snapshot', token);
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
  for (const id of new Set([...chromeMap.keys(), ...micaMap.keys(), ...Object.keys(baseline)])) {
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
    if (!previous && local && remote) continue;
    if (previous && localHash !== previous && remoteHash !== previous && localHash !== remoteHash) continue;
    const micaWins = (!local && !previous) || (previous && localHash === previous && remoteHash !== previous);
    if (micaWins) {
      await applyToChrome(remote || local, !remote);
      if (remote) baseline[id] = remoteHash;
      else delete baseline[id];
    } else {
      await post(local || remote, !local, token);
      if (local) baseline[id] = localHash;
      else delete baseline[id];
    }
  }
  await chrome.storage.local.set({ baseline });
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
  if (alarm.name === ALARM) void connect();
});
chrome.runtime.onStartup.addListener(() => {
  void connect();
});
chrome.runtime.onInstalled.addListener(() => {
  void connect();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.token) return;
  controller?.abort();
  connection?.finally(() => {
    void connect();
  });
  if (!connection) void connect();
});
void connect();

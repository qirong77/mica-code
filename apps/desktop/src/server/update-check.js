/* global __MICA_BUILD_COMMIT__, __MICA_BUILD_TIME__ */

const DEFAULT_REPOSITORY = 'qirong77/mica-code'
const DEFAULT_BRANCH = 'main'
const DEFAULT_TTL_MS = 10 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 8000

// Vite replaces these at build time. `typeof` keeps the source runtime usable in
// tests and in a source checkout that has not gone through the server build yet.
const BUILD_COMMIT =
  typeof __MICA_BUILD_COMMIT__ === 'string' && __MICA_BUILD_COMMIT__
    ? __MICA_BUILD_COMMIT__
    : 'unknown'
const BUILD_TIME =
  typeof __MICA_BUILD_TIME__ === 'string' && __MICA_BUILD_TIME__ ? __MICA_BUILD_TIME__ : null

export const UPDATE_REPOSITORY = process.env.MICA_UPDATE_REPOSITORY || DEFAULT_REPOSITORY
export const UPDATE_BRANCH = process.env.MICA_UPDATE_BRANCH || DEFAULT_BRANCH
export const UPDATE_COMMIT = BUILD_COMMIT
export const UPDATE_BUILD_TIME = BUILD_TIME
export const UPDATE_REPOSITORY_URL = `https://github.com/${UPDATE_REPOSITORY}`

function isSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{7,64}$/i.test(value)
}

function normalizeCommit(value) {
  return isSha(value) ? value.toLowerCase() : ''
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function commitUrl(repository, sha) {
  return `${repository}/commit/${encodeURIComponent(sha)}`
}

/**
 * GitHub commit polling is deliberately kept in the runtime rather than the
 * renderer. Remote Mica pages therefore check the machine that is actually
 * serving them, and a browser cannot turn this into an arbitrary fetch proxy.
 */
export function createUpdateChecker({
  currentCommit = UPDATE_COMMIT,
  repository = UPDATE_REPOSITORY,
  branch = UPDATE_BRANCH,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  ttlMs = Number(process.env.MICA_UPDATE_TTL_MS) || DEFAULT_TTL_MS,
  timeoutMs = Number(process.env.MICA_UPDATE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
} = {}) {
  const current = normalizeCommit(currentCommit)
  const repositoryUrl = `https://github.com/${repository}`
  const endpoint = `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(branch)}`
  let cached = null
  let checkedAt = 0
  let inFlight = null

  async function requestLatest() {
    if (typeof fetchImpl !== 'function') throw new Error('当前运行环境没有 fetch')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(endpoint, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'mica-code-update-check'
        },
        signal: controller.signal
      })
      if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`)
      const body = await response.json()
      const sha = normalizeCommit(body?.sha)
      if (!sha) throw new Error('GitHub 返回的提交号无效')
      return {
        latestCommit: sha,
        latestShortCommit: sha.slice(0, 7),
        latestMessage:
          typeof body?.commit?.message === 'string' ? body.commit.message.split('\n')[0] : '',
        latestDate: body?.commit?.committer?.date || body?.commit?.author?.date || null,
        latestUrl: commitUrl(repositoryUrl, sha)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async function check({ force = false } = {}) {
    const timestamp = now()
    if (!force && cached && timestamp - checkedAt < ttlMs) return cached
    if (inFlight) return inFlight
    inFlight = requestLatest()
      .then((latest) => {
        const result = {
          ok: true,
          available: Boolean(current && latest.latestCommit !== current),
          currentCommit: current || null,
          currentShortCommit: current ? current.slice(0, 7) : null,
          ...latest,
          repository: repositoryUrl,
          branch,
          checkedAt: now()
        }
        cached = result
        checkedAt = result.checkedAt
        return result
      })
      .catch((error) => {
        const result = {
          ok: false,
          available: false,
          currentCommit: current || null,
          currentShortCommit: current ? current.slice(0, 7) : null,
          repository: repositoryUrl,
          branch,
          error: errorText(error),
          checkedAt: now()
        }
        // A transient GitHub/network failure must not erase a previously
        // known update. Keep the last successful result available to callers.
        if (cached?.ok && cached.available) return { ...cached, stale: true, error: result.error }
        return result
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  return { check }
}

export const defaultUpdateChecker = createUpdateChecker()

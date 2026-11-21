import { describe, expect, test } from 'bun:test'
import { createLauncherFavicons, iconDataUrl, inlineIconDataUrl, MAX_ICON_BYTES } from './launcher-favicon.js'

function imageResponse(bytes, type = 'image/png', { ok = true } = {}) {
  return {
    ok,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? type : null) },
    arrayBuffer: async () => new Uint8Array(bytes).buffer
  }
}

describe('launcher favicon materializing', () => {
  test('inlines an icon so the launcher page can draw it under img-src data:', async () => {
    const asked = []
    const icons = createLauncherFavicons({
      fetchImage: async (url) => {
        asked.push(url)
        return imageResponse([1, 2, 3], 'image/png; charset=binary')
      }
    })
    expect(await icons.load('https://a.example/favicon.ico')).toBe(
      `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`
    )
    // The page asks again on every mount; the bytes are reused, not re-downloaded.
    expect(await icons.load('https://a.example/favicon.ico')).toStartWith('data:image/png;base64,')
    expect(asked).toHaveLength(1)
  })

  test('returns an empty string for failures, non-images and oversized icons', async () => {
    const icons = createLauncherFavicons({
      fetchImage: async (url) => {
        if (url.includes('missing')) return imageResponse([], 'image/png', { ok: false })
        if (url.includes('html')) return imageResponse([60, 33], 'text/html')
        if (url.includes('big')) return imageResponse(new Uint8Array(MAX_ICON_BYTES + 1), 'image/png')
        throw new Error('offline')
      }
    })
    expect(await icons.load('https://a.example/missing.ico')).toBe('')
    expect(await icons.load('https://a.example/html')).toBe('')
    expect(await icons.load('https://a.example/big.png')).toBe('')
    expect(await icons.load('https://a.example/offline.png')).toBe('')
    expect(await icons.load('')).toBe('')
    expect(await icons.load(null)).toBe('')
  })

  test('retries a failed icon instead of caching the miss', async () => {
    let attempts = 0
    const icons = createLauncherFavicons({
      fetchImage: async () => {
        attempts += 1
        return attempts === 1 ? imageResponse([], 'image/png', { ok: false }) : imageResponse([9], 'image/x-icon')
      }
    })
    expect(await icons.load('https://a.example/favicon.ico')).toBe('')
    expect(await icons.load('https://a.example/favicon.ico')).toBe(
      `data:image/x-icon;base64,${Buffer.from([9]).toString('base64')}`
    )
    expect(attempts).toBe(2)
  })

  test('dedupes concurrent requests for the same icon', async () => {
    let calls = 0
    const icons = createLauncherFavicons({
      fetchImage: async () => {
        calls += 1
        await new Promise((resolve) => setTimeout(resolve, 5))
        return imageResponse([7], 'image/svg+xml')
      }
    })
    const [first, second] = await Promise.all([
      icons.load('https://a.example/icon.svg'),
      icons.load('https://a.example/icon.svg')
    ])
    expect(first).toBe(second)
    expect(first).toStartWith('data:image/svg+xml;base64,')
    expect(calls).toBe(1)
  })

  test('drops a cached entry once the cache is full', async () => {
    let calls = 0
    const icons = createLauncherFavicons({
      fetchImage: async () => {
        calls += 1
        return imageResponse([1], 'image/png')
      },
      cacheLimit: 1
    })
    await icons.load('https://a.example/one.png')
    await icons.load('https://a.example/two.png')
    await icons.load('https://a.example/one.png')
    expect(calls).toBe(3)
  })
})

describe('icon data url encoding', () => {
  test('only known image types become data urls', () => {
    expect(iconDataUrl('image/png', [1])).toBe('data:image/png;base64,AQ==')
    expect(iconDataUrl('IMAGE/PNG', [1])).toBe('data:image/png;base64,AQ==')
    expect(iconDataUrl('text/html', [1])).toBe('')
    expect(iconDataUrl('image/png', [])).toBe('')
    expect(iconDataUrl('', [1])).toBe('')
  })
})

describe('inline icons', () => {
  const svg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3C/svg%3E"

  test('passes an inline icon straight through without a fetch', async () => {
    let calls = 0
    const icons = createLauncherFavicons({ fetchImage: async () => { calls += 1; return imageResponse([1]) } })
    expect(await icons.load(svg)).toBe(svg)
    expect(calls).toBe(0)
  })

  test('accepts only image data urls, within the size cap', () => {
    expect(inlineIconDataUrl(svg)).toBe(svg)
    expect(inlineIconDataUrl('data:image/png;base64,AQ==')).toBe('data:image/png;base64,AQ==')
    expect(inlineIconDataUrl('data:text/html,<b>x</b>')).toBe('')
    expect(inlineIconDataUrl('data:image/nonsense,AQ==')).toBe('')
    expect(inlineIconDataUrl('data:image/png')).toBe('')
    expect(inlineIconDataUrl('https://a.example/favicon.ico')).toBe('')
    expect(inlineIconDataUrl(null)).toBe('')
    expect(inlineIconDataUrl(`data:image/png;base64,${'A'.repeat(MAX_ICON_BYTES)}`)).toBe('')
  })
})

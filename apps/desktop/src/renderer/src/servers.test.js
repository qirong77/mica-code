import { describe, expect, test } from 'bun:test'
import {
  LOCAL_SERVER_URL,
  currentServerUrl,
  isLoopbackServer,
  isSameServer,
  serverEntryFor,
  serverEntryLabel,
  serverLabel
} from './servers'

describe('currentServerUrl', () => {
  test('uses the page origin, which is the runtime hosting it', () => {
    expect(currentServerUrl({ origin: 'http://192.168.1.5:8787' })).toBe('http://192.168.1.5:8787')
    expect(currentServerUrl(undefined)).toBe('')
  })
})

describe('isLoopbackServer', () => {
  test('recognizes the machine the page runs on', () => {
    for (const url of [LOCAL_SERVER_URL, 'http://localhost:8787', 'http://[::1]:9000']) {
      expect(isLoopbackServer(url)).toBe(true)
    }
    for (const url of ['http://192.168.1.5:8787', 'http://box:8787', 'nonsense']) {
      expect(isLoopbackServer(url)).toBe(false)
    }
  })
})

describe('serverLabel', () => {
  test('calls loopback "本机" and keeps host:port for the rest', () => {
    expect(serverLabel(LOCAL_SERVER_URL)).toBe('本机')
    expect(serverLabel('http://192.168.1.5:8787')).toBe('192.168.1.5:8787')
    expect(serverLabel('http://box:9000')).toBe('box:9000')
  })
})

describe('isSameServer', () => {
  test('compares hosts and ignores the path', () => {
    expect(isSameServer('http://box:8787', 'http://box:8787/api/health')).toBe(true)
    expect(isSameServer('http://box:8787', 'http://box:9000')).toBe(false)
    expect(isSameServer('http://box:8787', 'not a url')).toBe(false)
  })
})

describe('serverEntryLabel', () => {
  test('prefers the note the user gave the machine', () => {
    expect(serverEntryLabel({ url: 'http://192.168.1.5:8787', note: '构建机' })).toBe('构建机')
  })

  test('falls back to host:port without a note', () => {
    expect(serverEntryLabel({ url: 'http://192.168.1.5:8787', note: '' })).toBe('192.168.1.5:8787')
    expect(serverEntryLabel({ url: 'http://192.168.1.5:8787' })).toBe('192.168.1.5:8787')
    expect(serverEntryLabel({ url: LOCAL_SERVER_URL, note: '   ' })).toBe('本机')
    expect(serverEntryLabel(null)).toBe('')
  })
})

describe('serverEntryFor', () => {
  test('finds the entry of the server hosting the page', () => {
    const servers = [
      { url: 'http://192.168.1.5:8787', note: '构建机' },
      { url: 'http://box:9000', note: '' }
    ]
    expect(serverEntryFor(servers, 'http://192.168.1.5:8787')).toMatchObject({ note: '构建机' })
    expect(serverEntryFor(servers, 'http://elsewhere:8787')).toBeNull()
    expect(serverEntryFor(undefined, 'http://box:9000')).toBeNull()
  })
})

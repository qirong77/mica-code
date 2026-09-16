import { describe, expect, test } from 'bun:test'
import {
  LOCAL_SERVER_URL,
  currentServerUrl,
  isLoopbackServer,
  isSameServer,
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

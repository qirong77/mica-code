import { describe, expect, it } from 'vitest'
import {
  fileUrlsToPaths,
  matchPastedFilePaths,
  parseClipboardPayload,
  parseFilenamesPlist
} from './clipboard-files'

describe('parseFilenamesPlist', () => {
  it('reads paths out of the XML plist Finder puts on the pasteboard', () => {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<array>
\t<string>/tmp/报告</string>
\t<string>/tmp/a &amp; b.xlsx</string>
</array>
</plist>`
    expect(parseFilenamesPlist(plist)).toEqual(['/tmp/报告', '/tmp/a & b.xlsx'])
  })

  it('ignores binary plists and empty input', () => {
    expect(parseFilenamesPlist('bplist00\u0000\u0000')).toEqual([])
    expect(parseFilenamesPlist('')).toEqual([])
  })
})

describe('fileUrlsToPaths', () => {
  it('decodes percent-encoded file URLs', () => {
    expect(fileUrlsToPaths('file:///tmp/%E6%8A%A5%E5%91%8A/report.xlsx')).toEqual([
      '/tmp/报告/report.xlsx'
    ])
  })

  it('skips comments and non-file URIs', () => {
    expect(fileUrlsToPaths('# comment\nhttps://example.com/a\nfile:///tmp/a.txt')).toEqual([
      '/tmp/a.txt'
    ])
  })
})

describe('parseClipboardPayload', () => {
  it('merges every macOS format without duplicating entries', () => {
    const paths = parseClipboardPayload({
      list: ['/tmp/a.xlsx'],
      plist: '<plist><array><string>/tmp/a.xlsx</string><string>/tmp/b</string></array></plist>',
      url: 'file:///tmp/a.xlsx',
      uriList: null
    })
    expect(paths).toEqual(['/tmp/a.xlsx', '/tmp/b'])
  })
})

describe('matchPastedFilePaths', () => {
  it('matches pasted names by basename and keeps the paste order', () => {
    const paths = ['/home/u/reports/b.xlsx', '/home/u/reports/a.xlsx', '/home/u/报告']
    expect(matchPastedFilePaths(['a.xlsx', '报告'], paths)).toEqual([
      '/home/u/reports/a.xlsx',
      '/home/u/报告'
    ])
  })

  it('never falls back to unrelated clipboard entries', () => {
    expect(matchPastedFilePaths(['other.xlsx'], ['/tmp/a.xlsx'])).toEqual([])
    expect(matchPastedFilePaths([], ['/tmp/a.xlsx'])).toEqual([])
  })

  it('matches case-insensitively so macOS copies still resolve', () => {
    expect(matchPastedFilePaths(['Report.XLSX'], ['/tmp/report.xlsx'])).toEqual([
      '/tmp/report.xlsx'
    ])
  })
})

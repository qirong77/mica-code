/**
 * Shared content for every Notebook design preview.
 * These are serialized Lexical nodes, loaded by the existing NotebookFrame.
 * No preview-only renderer, Markdown parser, or editor engine is involved.
 */
export interface PreviewNotebookDocument {
  version: 1
  editorState: string
  comments: unknown[]
}

export interface PreviewNote {
  id: string
  title: string
  folder: string
  description: string
  updatedAt: string
  document: PreviewNotebookDocument
}

type SerializedNode = {
  type: string
  version: 1
  children?: SerializedNode[]
  [key: string]: unknown
}
type Inline = string | SerializedNode

// Lexical 0.53 text format flags. Keep all appearance in the shared editor theme.
const BOLD = 1
const ITALIC = 2
const STRIKE = 4
const UNDERLINE = 8
const CODE = 16
const HIGHLIGHT = 128

const text = (value: string, format = 0): SerializedNode => ({
  type: 'text',
  version: 1,
  text: value,
  format,
  detail: 0,
  mode: 'normal',
  style: ''
})
const inlines = (values: Inline[]): SerializedNode[] =>
  values.map((value) => (typeof value === 'string' ? text(value) : value))
const element = (
  type: string,
  children: SerializedNode[],
  properties: Record<string, unknown> = {}
): SerializedNode => ({
  type,
  version: 1,
  children,
  direction: null,
  format: '',
  indent: 0,
  ...properties
})
const paragraph = (...values: Inline[]) =>
  element('paragraph', inlines(values), { textFormat: 0, textStyle: '' })
const heading = (tag: 'h1' | 'h2' | 'h3', value: string) =>
  element('heading', [text(value)], { tag })
const quote = (...values: Inline[]) => element('quote', inlines(values))
const item = (...values: Inline[]) => element('listitem', inlines(values), { value: 1 })
const task = (checked: boolean, ...values: Inline[]) => ({ ...item(...values), checked })
const list = (listType: 'bullet' | 'number' | 'check', items: SerializedNode[]) => {
  let value = 1
  return element(
    'list',
    items.map((node) => {
      const next = { ...node, value }
      if (node.children?.[0]?.type !== 'list') value++
      return next
    }),
    { listType, start: 1, tag: listType === 'number' ? 'ol' : 'ul' }
  )
}
// Lexical uses a sibling list item to contain a nested list.
const nested = (node: SerializedNode) => element('listitem', [node], { value: 1 })
const link = (label: string, url: string): SerializedNode =>
  element('link', [text(label)], {
    url,
    rel: 'noreferrer',
    target: '_blank',
    title: null
  })
const code = (language: string, source: string): SerializedNode =>
  element('code', [text(source)], { language, direction: 'ltr' })
const rule = (): SerializedNode => ({ type: 'horizontalrule', version: 1 })
const equation = (value: string, inline = false): SerializedNode => ({
  type: 'equation',
  version: 1,
  equation: value,
  inline
})
const root = (children: SerializedNode[]) => element('root', children)
const document = (children: SerializedNode[]): PreviewNotebookDocument => ({
  version: 1,
  editorState: JSON.stringify({ root: root(children) }),
  comments: []
})
const table = (rows: string[][]): SerializedNode =>
  element(
    'table',
    rows.map((cells, row) =>
      element(
        'tablerow',
        cells.map((value) =>
          element('tablecell', [paragraph(value)], {
            colSpan: 1,
            rowSpan: 1,
            headerState: row === 0 ? 1 : 0,
            backgroundColor: null
          })
        )
      )
    ),
    { colWidths: rows[0]?.length === 4 ? [104, 244, 232, 116] : [148, 242, 306] }
  )

// Embedded by the fixture generator from assets/field-notes-landscape.svg.
// A data URI also works inside NotebookFrame's opaque-origin iframe.
const landscapeSource =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNjAwIiBoZWlnaHQ9IjY0MCIgdmlld0JveD0iMCAwIDE2MDAgNjQwIiBmaWxsPSJub25lIiByb2xlPSJpbWciIGFyaWEtbGFiZWxsZWRieT0idGl0bGUgZGVzYyI+CiAgPHRpdGxlIGlkPSJ0aXRsZSI+5bGx6Ze055qE5oCd6LevPC90aXRsZT4KICA8ZGVzYyBpZD0iZGVzYyI+5Y6f5Yib5oq96LGh5o+S5Zu+44CC57q455m95aSp56m644CB6Z2S57u/5bGC5bGx5LiO5pqW54Gw5L6/562+77yM5Yeg5p6a57uG57q/6L+e5o6l55qE5ZyG54K55LuO6KeC5a+f6YCa5ZCR6KGM5Yqo44CCPC9kZXNjPgogIDxkZWZzPgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJza3kiIHgxPSI4MDAiIHkxPSIwIiB4Mj0iODAwIiB5Mj0iNjQwIiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+CiAgICAgIDxzdG9wIHN0b3AtY29sb3I9IiNGNEYzRUQiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNFOUVERTUiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9InJpZGdlIiB4MT0iMCIgeTE9IjMwNyIgeDI9IjE2MDAiIHkyPSI2MDMiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIj4KICAgICAgPHN0b3Agc3RvcC1jb2xvcj0iI0I0QzlCQyIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iI0M1RDFCRSIvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0ibmVhciIgeDE9IjkwMCIgeTE9IjQyNiIgeDI9IjUwMCIgeTI9IjcwMCIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPgogICAgICA8c3RvcCBzdG9wLWNvbG9yPSIjNzk5OThCIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjNTU3QzcwIi8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJwYXBlciIgeDE9IjExMjkiIHkxPSIxNDMiIHgyPSIxMTI5IiB5Mj0iNDgwIiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+CiAgICAgIDxzdG9wIHN0b3AtY29sb3I9IiNGRkZFRjgiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNGNEYyRTgiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8ZmlsdGVyIGlkPSJzaGFkb3ciIHg9Ii0zMCUiIHk9Ii0zMCUiIHdpZHRoPSIxNzAlIiBoZWlnaHQ9IjE4MCUiPjxmZURyb3BTaGFkb3cgZHg9IjAiIGR5PSIxNSIgc3RkRGV2aWF0aW9uPSIxNyIgZmxvb2QtY29sb3I9IiMzRDVBNTAiIGZsb29kLW9wYWNpdHk9Ii4wOSIvPjwvZmlsdGVyPgogICAgPHBhdHRlcm4gaWQ9ImdyYWluIiB3aWR0aD0iMTIiIGhlaWdodD0iMTIiIHBhdHRlcm5Vbml0cz0idXNlclNwYWNlT25Vc2UiPjxjaXJjbGUgY3g9IjEiIGN5PSIxIiByPSIuNTUiIGZpbGw9IiM2NDczNjYiIG9wYWNpdHk9Ii4xMSIvPjxjaXJjbGUgY3g9IjciIGN5PSI4IiByPSIuNDUiIGZpbGw9IiM2NDczNjYiIG9wYWNpdHk9Ii4wOCIvPjwvcGF0dGVybj4KICAgIDxjbGlwUGF0aCBpZD0iZnJhbWUiPjxyZWN0IHdpZHRoPSIxNjAwIiBoZWlnaHQ9IjY0MCIgcng9IjI0Ii8+PC9jbGlwUGF0aD4KICA8L2RlZnM+CiAgPGcgY2xpcC1wYXRoPSJ1cmwoI2ZyYW1lKSI+CiAgICA8cmVjdCB3aWR0aD0iMTYwMCIgaGVpZ2h0PSI2NDAiIGZpbGw9InVybCgjc2t5KSIvPgogICAgPGNpcmNsZSBjeD0iMjg3IiBjeT0iMTY0IiByPSI2MCIgZmlsbD0iI0UzRDRCNiIgb3BhY2l0eT0iLjc4Ii8+CiAgICA8Y2lyY2xlIGN4PSIyODciIGN5PSIxNjQiIHI9IjgzIiBzdHJva2U9IiNDQkJFOUYiIHN0cm9rZS1vcGFjaXR5PSIuMjUiLz4KICAgIDxwYXRoIGQ9Ik0tNDAgMzg1QzEwNyAzNDMgMTcyIDI4NSAyODYgMzAyQzQyMCAzMjIgNDY2IDIxMiA2MDIgMjQyQzczMCAyNzEgODAzIDM3MCA5NDMgMzM1QzEwNzggMzAyIDEyMjYgMjIwIDEzNjEgMjcwQzE0OTYgMzIwIDE1NTQgMjg4IDE2NTAgMjYxVjY4MEgtNDBWMzg1WiIgZmlsbD0iI0QzREREMSIvPgogICAgPHBhdGggZD0iTS00MCA0MzdDOTQgMzgwIDIxMSAzOTQgMzMyIDM0MkM0MjEgMzA0IDUwMSAzMTkgNTk1IDM2NkM3MTUgNDI2IDc4NiAzNjggOTA0IDM3NkMxMDIwIDM4NCAxMTAwIDQ1OSAxMjE4IDQyNUMxMzUxIDM4NyAxNDg3IDM1NiAxNjUwIDM5OVY2ODBILTQwVjQzN1oiIGZpbGw9InVybCgjcmlkZ2UpIi8+CiAgICA8cGF0aCBkPSJNLTQwIDU0NEMxMjAgNDg4IDIyNyA1MjggMzUyIDQ3OUM0OTIgNDI0IDU2MyA0NTEgNjg1IDQ3MkM4MjcgNDk3IDg4NCA0NTUgMTAxMSA0NjlDMTE1MCA0ODQgMTI2MCA1MzMgMTM4NyA0OTFDMTQ4NiA0NTkgMTU3MSA0NjYgMTY1MCA0NzlWNjgwSC00MFY1NDRaIiBmaWxsPSJ1cmwoI25lYXIpIi8+CiAgICA8cGF0aCBkPSJNMjI3IDY4MEMzNTUgNTYzIDQ5MyA2MDMgNjA4IDUzOUM3MDQgNDg2IDc0NCA0MzQgODQxIDQyMkM5MTMgNDEzIDk1NSA0MzEgMTAwNyA0NTYiIHN0cm9rZT0iI0RDRTRENCIgc3Ryb2tlLW9wYWNpdHk9Ii43MiIgc3Ryb2tlLXdpZHRoPSIzIiBzdHJva2UtbGluZWNhcD0icm91bmQiLz4KICAgIDxwYXRoIGQ9Ik0yNTUgNjgwQzM4MyA1NjYgNTA4IDYxMSA2MjUgNTQ2QzcxNCA0OTYgNzU4IDQ0MyA4NDcgNDM1IiBzdHJva2U9IiNFQ0VEREUiIHN0cm9rZS1vcGFjaXR5PSIuMzMiIHN0cm9rZS13aWR0aD0iMS41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz4KICAgIDxnIHN0cm9rZT0iIzYzODQ3NiIgc3Ryb2tlLXdpZHRoPSIxLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+CiAgICAgIDxwYXRoIGQ9Ik00OTggMjA0QzU5NiAxNDMgNjc5IDE1NiA3NjAgMjA4Qzg1MSAyNjcgOTAzIDIxMCA5NzEgMjM2IiBzdHJva2UtZGFzaGFycmF5PSIzIDkiLz4KICAgICAgPHBhdGggZD0iTTc2MSAyMDhDNzQ1IDI3MiA3NzcgMzExIDgzNSAzMzgiIHN0cm9rZS1kYXNoYXJyYXk9IjMgOSIvPgogICAgICA8Y2lyY2xlIGN4PSI0OTgiIGN5PSIyMDQiIHI9IjkiIGZpbGw9IiNGNEYzRUQiLz4KICAgICAgPGNpcmNsZSBjeD0iNzYxIiBjeT0iMjA4IiByPSIxMyIgZmlsbD0iI0UyRThEQiIvPgogICAgICA8Y2lyY2xlIGN4PSI4MzUiIGN5PSIzMzgiIHI9IjciIGZpbGw9IiNFMkU4REIiLz4KICAgICAgPGNpcmNsZSBjeD0iOTcxIiBjeT0iMjM2IiByPSI3IiBmaWxsPSIjRjRGM0VEIi8+CiAgICA8L2c+CiAgICA8ZyB0cmFuc2Zvcm09InJvdGF0ZSg3IDExOTAgMjg4KSIgb3BhY2l0eT0iLjgiPjxyZWN0IHg9IjEwNTMiIHk9IjE1MyIgd2lkdGg9IjI3NyIgaGVpZ2h0PSIzMDAiIHJ4PSIxMyIgZmlsbD0iI0QxQ0NCQyIvPjwvZz4KICAgIDxnIHRyYW5zZm9ybT0icm90YXRlKC01IDExNDggMzAyKSIgZmlsdGVyPSJ1cmwoI3NoYWRvdykiPgogICAgICA8cmVjdCB4PSI5OTciIHk9IjEzNSIgd2lkdGg9IjI5MiIgaGVpZ2h0PSIzMjUiIHJ4PSIxMiIgZmlsbD0idXJsKCNwYXBlcikiIHN0cm9rZT0iI0RBRENEMCIvPgogICAgICA8cGF0aCBkPSJNMTIxOCAxMzVWMTc3QzEyMTggMTg0IDEyMjQgMTkwIDEyMzEgMTkwSDEyODkiIGZpbGw9IiNFN0U2RDkiLz4KICAgICAgPHBhdGggZD0iTTEyMTggMTM2TDEyODggMTkwIiBzdHJva2U9IiNEN0Q5Q0EiLz4KICAgICAgPHJlY3QgeD0iMTAzMyIgeT0iMTc4IiB3aWR0aD0iNjgiIGhlaWdodD0iNyIgcng9IjMuNSIgZmlsbD0iIzdDOUM4QiIvPgogICAgICA8cGF0aCBkPSJNMTAzMyAyMTlIMTIwOU0xMDMzIDIzOEgxMTc0IiBzdHJva2U9IiNDRkQ1QzgiIHN0cm9rZS13aWR0aD0iNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+CiAgICAgIDxyZWN0IHg9IjEwMzMiIHk9IjI3OSIgd2lkdGg9IjE1IiBoZWlnaHQ9IjE1IiByeD0iNCIgc3Ryb2tlPSIjODQ5RjhFIiBzdHJva2Utd2lkdGg9IjEuNSIvPgogICAgICA8cGF0aCBkPSJNMTAzNyAyODZMMTA0MSAyOTBMMTA0NiAyODMiIHN0cm9rZT0iIzZEOEY3QSIgc3Ryb2tlLXdpZHRoPSIxLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgogICAgICA8cGF0aCBkPSJNMTA2MyAyODZIMTIwOCIgc3Ryb2tlPSIjQURCREFBIiBzdHJva2Utd2lkdGg9IjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgogICAgICA8cmVjdCB4PSIxMDMzIiB5PSIzMTkiIHdpZHRoPSIxNSIgaGVpZ2h0PSIxNSIgcng9IjQiIHN0cm9rZT0iIzg0OUY4RSIgc3Ryb2tlLXdpZHRoPSIxLjUiLz4KICAgICAgPHBhdGggZD0iTTEwNjMgMzI2SDExNzciIHN0cm9rZT0iI0NGRDVDOCIgc3Ryb2tlLXdpZHRoPSI1IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz4KICAgICAgPHJlY3QgeD0iMTAzMyIgeT0iMzU5IiB3aWR0aD0iMTUiIGhlaWdodD0iMTUiIHJ4PSI0IiBzdHJva2U9IiM4NDlGOEUiIHN0cm9rZS13aWR0aD0iMS41Ii8+CiAgICAgIDxwYXRoIGQ9Ik0xMDYzIDM2NkgxMTkzIiBzdHJva2U9IiNDRkQ1QzgiIHN0cm9rZS13aWR0aD0iNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+CiAgICAgIDxjaXJjbGUgY3g9IjEyMzgiIGN5PSI0MTciIHI9IjEzIiBmaWxsPSIjRTJFN0Q2Ii8+CiAgICAgIDxwYXRoIGQ9Ik0xMjMzIDQxN0gxMjQzTTEyMzggNDEyTDEyNDMgNDE3TDEyMzggNDIyIiBzdHJva2U9IiM3RjlBODMiIHN0cm9rZS13aWR0aD0iMS40IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz4KICAgIDwvZz4KICAgIDxnIGZpbGw9IiM0NTZDNjAiIHN0cm9rZT0iIzQ1NkM2MCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIj4KICAgICAgPHBhdGggZD0iTTE0MjkgNDY2VjU0NyIgc3Ryb2tlLXdpZHRoPSIzIi8+PHBhdGggZD0iTTE0MjkgNDI5TDE0MDUgNDgzSDE0NTNMMTQyOSA0MjlaIi8+PHBhdGggZD0iTTE0MjkgNDU3TDEzOTQgNTE1SDE0NjRMMTQyOSA0NTdaIi8+CiAgICAgIDxwYXRoIGQ9Ik0xMzc0IDUwMVY1NTQiIHN0cm9rZS13aWR0aD0iMiIvPjxwYXRoIGQ9Ik0xMzc0IDQ3NkwxMzU0IDUyMkgxMzk0TDEzNzQgNDc2WiIvPgogICAgPC9nPgogICAgPHBhdGggZD0iTTEwNiA1ODBIMTg1TTE0NSA1NDFWNjIwIiBzdHJva2U9IiNEREU0RDQiIHN0cm9rZS1vcGFjaXR5PSIuNCIvPgogICAgPGNpcmNsZSBjeD0iMTQ1IiBjeT0iNTgwIiByPSIyMyIgc3Ryb2tlPSIjRERFNEQ0IiBzdHJva2Utb3BhY2l0eT0iLjQiLz4KICAgIDxyZWN0IHdpZHRoPSIxNjAwIiBoZWlnaHQ9IjY0MCIgZmlsbD0idXJsKCNncmFpbikiIG9wYWNpdHk9Ii4zOCIvPgogICAgPHBhdGggZD0iTTY1IDY1SDEwOU02NSA2NVYxMDlNMTUzNSA2NUgxNDkxTTE1MzUgNjVWMTA5TTE1MzUgNTc1SDE0OTFNMTUzNSA1NzVWNTMxIiBzdHJva2U9IiM4RUEwOEQiIHN0cm9rZS1vcGFjaXR5PSIuMzUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgogIDwvZz4KPC9zdmc+Cg=='
const landscape = (caption: string) =>
  paragraph({
    type: 'image',
    version: 1,
    src: landscapeSource,
    altText: '纸白天空下，青绿层山与暖灰便签相连；细线圆点描绘从观察走向行动的路径。',
    maxWidth: 1600,
    width: 0,
    height: 0,
    showCaption: true,
    caption: { editorState: { root: root([paragraph(caption)]) } }
  })

export const primaryNoteId = 'idea-to-delivery'

export const previewNotes: PreviewNote[] = [
  {
    id: primaryNoteId,
    title: '把灵感，写成下一步',
    folder: '产品与设计',
    description: '一份从观察、讨论到实现的工作手记。让想法有来处，让下一步有着落。',
    updatedAt: '2026-04-17T10:32:00+08:00',
    document: document([
      heading('h1', '把灵感，写成下一步'),
      paragraph(
        '有些想法很轻：一次卡住的操作、一段顺手记下的话、散会后仍然想追问的问题。写下来，是为了让它们在下一次打开时，仍然可以继续。'
      ),
      paragraph(
        '这份手记记录我们如何整理一个小型的笔记工作台。目标很朴素：',
        text('让记录自然发生，让行动容易找到。', BOLD),
        '先把眼前的一段工作照顾好，再决定它需要长成什么样。'
      ),
      landscape('山间的思路 · 原创插图。把零散观察连成路径，也给尚未成形的想法留一点空白。'),
      heading('h2', '01 · 先把问题写清楚'),
      paragraph(
        '设想一个普通的下午：方案讨论结束，桌面上留下会议纪要、几张截图，以及一句“下次再看看”。记录并没有丢失，但第二天回到这里，仍然需要重新拼接背景。我们想改善的，是从“记过了”到“还能接着做”之间的这段距离。'
      ),
      paragraph(
        '因此，第一页不急着放满信息。标题回答这是什么，开头说明为什么写，后面的结构帮助读者判断哪里值得停下来。',
        text('一篇可继续的笔记', ITALIC),
        '可以不完整，但应当保留问题的来处、当前的判断，以及尚未解决的分歧。'
      ),
      quote(
        '好的记录不替人做决定。它把事实、假设与选择摆在同一张桌上，让下一次讨论可以从更靠近答案的地方开始。'
      ),
      heading('h3', '观察、判断和暂时的边界'),
      list('bullet', [
        item(text('观察：', BOLD), '同一个问题常出现在不同文档里，背景却没有一起移动。'),
        nested(
          list('bullet', [
            item('原始材料保留上下文，摘录注明来源，避免一句话在转述中改变含义。'),
            item('先记下具体场景，再写我们的解释；没有证据的判断应当保持可修改。')
          ])
        ),
        item(
          text('判断：', BOLD),
          '整理的成本应该小于重新寻找的成本。常用动作靠近内容，偶尔使用的能力保持安静。'
        ),
        item(
          text('边界：', BOLD),
          '本轮先覆盖个人记录与小范围评审，跨团队的权限和发布流程另开议题。'
        )
      ]),
      paragraph(
        '早期写下的 ',
        text('先把所有工具都放到顶部', STRIKE),
        ' 已经划去。现在更愿意保留一个清晰的主入口，把低频操作交给上下文。',
        text('当前只承诺：正文可持续编辑，草稿有明确的保存反馈。', HIGHLIGHT),
        '这句话会在评审时逐条核对。'
      ),
      heading('h2', '02 · 从观察到一项可验证的工作'),
      paragraph(
        '把灵感拆成任务之前，先问它要改善哪一个时刻。这里不写“提升体验”这样宽泛的目标，而是描述一次可以被复现的过程：打开昨天的笔记，找到未完成的问题，补上一段结论，然后知道内容已经保存。'
      ),
      list('number', [
        item(
          text('保留现场。', BOLD),
          '写下触发问题的操作、当时的预期与实际结果；截图只补充难以用语言表达的细节。'
        ),
        item(
          text('缩小决定。', BOLD),
          '用一两个候选方案讨论取舍，说明各自解决什么、增加什么成本。暂时无法判断的部分单独标记。'
        ),
        nested(
          list('number', [
            item('先做可点击的局部预览，观察标题、正文和工具之间的注意力分配。'),
            item('再放入一篇足够长的真实结构，检查连续阅读时是否仍然从容。')
          ])
        ),
        item(
          text('约定回看。', BOLD),
          '给下一步一个明确的产出与检查方式。没有进入本轮的想法留在记录里，而不是挤进交付清单。'
        )
      ]),
      code(
        'mermaid',
        'flowchart LR\n  A[记录观察] --> B[写清问题]\n  B --> C{值得本轮验证?}\n  C -->|是| D[做一个小实验]\n  D --> E[回看并记录决定]\n  C -->|稍后| F[保留线索]\n  E -.新问题.-> A'
      ),
      paragraph(
        '这条路径允许回头。实验没有支持最初的判断，也是一份有用的结果。把变化的原因补在原处，比悄悄覆盖旧结论更有价值。保留线索的列表每周回看一次，过时的想法可以归档，仍然重要的再进入讨论。'
      ),
      heading('h3', '这一轮的工作板'),
      table([
        ['工作项', '交付内容', '检查方式', '进度'],
        ['阅读层级', '标题与正文的排版', '长文连续阅读', '待评审'],
        ['记录入口', '新建与最近笔记', '键盘完成一次打开', '已梳理'],
        ['草稿反馈', '保存状态与失败提示', '模拟中断后继续编辑', '待验证'],
        ['复杂内容', '表格、代码与图表', '窄窗口与长内容', '进行中'],
        ['内容导航', '文档目录与当前位置', '跳转后返回原段落', '待评审'],
        ['收尾检查', '焦点与主题一致性', '明暗主题各走一遍', '待开始']
      ]),
      paragraph(
        '这张表只记录能交付的东西。进度描述的是讨论状态，不代表实现已经完成。发现阻碍时，优先补上“为什么卡住”和“需要谁一起决定”，让表格成为工作入口，而不是另一份需要维护的汇报。'
      ),
      heading('h2', '03 · 留下可以讨论的实现'),
      paragraph(
        '在实现层面，先让数据边界清楚。内容是一份文档，打开、编辑、保存围绕同一个标识进行。界面可以有不同的排版，但切换外观不应把正文变成另一种存储格式。以下类型用于讨论必要字段：'
      ),
      code(
        'typescript',
        'type Draft = {\n  id: string;\n  title: string;\n  revision: number;\n  state: "clean" | "dirty" | "saving";\n};\n\nconst canLeave = (draft: Draft): boolean =>\n  draft.state === "clean";'
      ),
      paragraph(
        '用 ',
        text('revision', CODE),
        ' 区分一次保存所对应的版本；只有收到与该版本匹配的确认，才把状态改成已保存。较晚到达的旧确认，不能盖住后续输入。命名的参考可放在 ',
        link(
          'MDN 的异步编程说明',
          'https://developer.mozilla.org/zh-CN/docs/Learn_web_development/Extensions/Async_JS'
        ),
        '，讨论时仍以这里约定的行为为准。'
      ),
      code(
        'mermaid',
        'sequenceDiagram\n  participant W as 作者\n  participant E as 编辑器\n  participant D as 本地草稿\n  W->>E: 修改一段内容\n  E->>D: 写入当前版本\n  alt 写入成功\n    D-->>E: 确认版本\n    E-->>W: 已保存\n  else 暂时失败\n    E-->>W: 保留输入，提示重试\n  end'
      ),
      heading('h3', '为什么先保住草稿'),
      paragraph(
        '写作的节奏很容易被打断。失败提示应该说明当前内容是否还在、接下来可以做什么；后台重试也需要尊重正在发生的编辑。',
        text('出现问题时，先让作者能够继续写。', UNDERLINE),
        '只有当当前内容确实无法安全保留时，才需要更强的中断。'
      ),
      paragraph(
        '排优先级时，可以借用一个简单的讨论模型。把影响范围记为 I，判断把握记为 C，投入记为 E；它帮助我们说清取舍，不用来制造精确的排名。'
      ),
      equation('P = \\frac{I \\times C}{E}'),
      paragraph(
        '如果把握来自猜测，就先补一次验证；如果投入仍然不清楚，就先把任务拆小。分数接近时，优先做能减少后续不确定性的工作。对于内容丢失这样后果明确的问题，不需要等模型给出漂亮的数字才处理。'
      ),
      heading('h2', '04 · 交付前，走完一次完整的使用'),
      paragraph(
        '评审从一段实际工作开始：新建笔记，粘贴材料，整理结构，插入图表，离开后再回来。单独看每个控件时不明显的割裂，常常会在这个过程中出现。检查也要给键盘、窄窗口和较长标题留出位置。'
      ),
      list('check', [
        task(true, '写明问题、边界与本轮交付，讨论可以从同一份背景开始。'),
        task(true, '为复杂内容准备可阅读的示例，避免只看空白页面。'),
        task(false, '验证保存失败后的继续编辑、重试和离开提示。'),
        task(false, '逐项检查表格滚动、图表查看以及关闭弹层后的焦点。'),
        task(false, '把本轮没有解决的问题写回记录，并约定下一次回看。')
      ]),
      rule(),
      heading('h3', '留给下一次打开这篇笔记的自己'),
      paragraph(
        '一个值得继续的问题：当材料越来越多，什么能帮助我们辨认“这件事为什么仍然重要”？也许不是更多标签，而是一段及时更新的背景说明，一条仍然有效的链接，以及一个足够具体的下一步。'
      ),
      paragraph(
        '下次从“草稿反馈”开始，把失败场景走通，再回来调整这份工作板。记录可以慢慢长出结构，决定也可以逐渐清楚。今天先把这一段写好。'
      )
    ])
  },
  {
    id: 'weekly-rhythm',
    title: '本周，把重要的事留出位置',
    folder: '工作手记',
    description: '04.20 — 04.24 · 三个关注点、每日安排，以及一段留给周五的回看。',
    updatedAt: '2026-04-17T09:10:00+08:00',
    document: document([
      heading('h1', '本周，把重要的事留出位置'),
      paragraph('04.20 — 04.24 · 周计划'),
      paragraph(
        '本周的中心是把笔记工作台走通一遍：从打开一份记录，到补充内容，再到带着明确的下一步离开。安排按注意力分配，不把每一个空格都填满。'
      ),
      quote('如果临时事项变多，先重新协商范围。不要让本来需要讨论的取舍，变成默认追加的工作。'),
      heading('h2', '三个关注点'),
      list('number', [
        item(
          text('先看完整路径。', BOLD),
          '用同一份长文比较不同界面，记录连续阅读和开始编辑时的感受。'
        ),
        item(text('把草稿照顾好。', BOLD), '补齐保存反馈的状态说明，明确失败后的处理。'),
        item(text('让反馈落到具体位置。', BOLD), '每条意见带上场景和段落，不只留下“这里有点挤”。')
      ]),
      heading('h2', '本周安排'),
      table([
        ['日期', '主任务', '留给协作的时间'],
        ['周一', '阅读与编辑路径走查', '整理评审材料'],
        ['周二', '比较排版与导航方案', '集中讨论取舍'],
        ['周三', '验证代码、表格和图表', '处理交互疑问'],
        ['周四', '补齐保存和异常场景', '核对文案'],
        ['周五', '复查完整流程，整理决定', '周回顾与归档']
      ]),
      heading('h3', '可以提前准备的材料'),
      list('check', [
        task(true, '一篇包含图片、表格和图表的长文。'),
        task(true, '一篇简短的周计划，用来检查轻量记录。'),
        task(false, '录下键盘完成新建、切换和返回正文的过程。'),
        task(false, '整理三条最影响继续写作的问题，带到评审。')
      ]),
      heading('h2', '本周不急着做的事'),
      paragraph(
        '标签体系与共享发布仍然值得讨论，但不占用本周的实现窗口。遇到相关想法，先在记录里留下“由哪个场景触发”和“以后如何验证”。周五回看时，再决定是否进入下一轮。'
      ),
      list('bullet', [
        item('上午尽量留给需要连续思考的任务，消息在阶段之间集中处理。'),
        item('下午保留一个协作窗口，优先处理会阻碍别人继续推进的问题。'),
        nested(
          list('bullet', [item('讨论前说明需要决定什么。'), item('讨论后把结论和未决项补回原文。')])
        )
      ]),
      rule(),
      heading('h2', '周五回看'),
      paragraph(
        text('本周真正推进了什么？', BOLD),
        '写一个具体变化，不罗列所有完成的动作。接着记录一次偏离计划的原因，判断它来自信息不足、范围变化，还是安排过满。'
      ),
      paragraph(
        '给下一周保留一句提醒：',
        text('不要为了让计划看起来完整，把尚未达成共识的决定写成承诺。', HIGHLIGHT)
      )
    ])
  },
  {
    id: 'adr-local-drafts',
    title: 'ADR 014 · 草稿保存的边界',
    folder: '研发记录',
    description: '讨论稿 · 用版本确认定义保存状态，明确失败、重试与切换文档时的行为。',
    updatedAt: '2026-04-16T16:45:00+08:00',
    document: document([
      heading('h1', 'ADR 014 · 草稿保存的边界'),
      paragraph('状态：讨论稿 · 范围：个人笔记 · 关联：编辑与离开文档'),
      paragraph(
        '这份记录约定草稿接口的行为，供界面、编辑器和存储层一起评审。文中的接口与数据均为构造示例，不对应外部服务。'
      ),
      heading('h2', '背景'),
      paragraph(
        '保存往往发生在作者没有主动按下按钮的时候。输入仍在继续，确认可能延迟，旧请求也可能比新请求更晚结束。如果界面把任意一次成功都显示为“已保存”，作者看到的状态就可能领先于真正落盘的内容。'
      ),
      heading('h2', '决定'),
      paragraph(
        '每次提交携带文档标识与递增版本。确认消息必须返回同一组标识；编辑器只接受与当前提交对应的确认。',
        text('已保存意味着当前版本已经写入。', BOLD),
        '较旧版本成功，不会清除新版本的未保存状态。'
      ),
      code(
        'typescript',
        'type SaveRequest = {\n  noteId: string;\n  revision: number;\n  document: NotebookDocument;\n};\n\ntype SaveResult =\n  | { ok: true; revision: number }\n  | { ok: false; reason: "write-failed" };'
      ),
      heading('h3', '约定的状态转换'),
      table([
        ['当前状态', '事件', '下一步'],
        ['已保存', '产生新编辑', '进入未保存'],
        ['未保存', '触发写入', '进入保存中'],
        ['保存中', '收到匹配确认', '当前版本标为已保存'],
        ['保存中', '又产生编辑', '保留新版本的未保存状态'],
        ['保存中', '写入失败', '显示失败，保留正文并允许重试'],
        ['失败', '再次写入成功', '以最新版本确认更新状态']
      ]),
      heading('h2', '考虑过的另一种做法'),
      paragraph(
        '也可以只维护一个布尔值 ',
        text('isSaving', CODE),
        '。实现较短，但无法说明哪一份内容已经保存，也难以区分“旧请求结束”和“新内容落盘”。本轮选择显式版本，增加少量状态处理，换取可解释的行为。'
      ),
      quote('错误状态不是终点。作者需要知道输入仍然保留、可以怎样重试，以及此刻离开会发生什么。'),
      heading('h2', '失败与离开'),
      list('bullet', [
        item('写入失败后保留正文与修改记录，不清空输入，也不回退到旧内容。'),
        item('切换文档前请求一次提交，只有当前版本确认后才完成切换。'),
        item('重试使用最新快照；重复确认需要可以安全忽略。'),
        item('暂不在此协议里定义多人冲突解决，相关需求另建决策记录。')
      ]),
      heading('h2', '需要验证'),
      list('check', [
        task(false, '让两个写入反向结束，确认旧结果不会盖掉新编辑。'),
        task(false, '模拟一次失败后继续输入，再重试保存。'),
        task(false, '在图片说明仍有未提交输入时切换文档。'),
        task(false, '检查保存提示能被键盘与辅助技术读取。')
      ]),
      rule(),
      paragraph(
        '开放问题：外部文件被修改时，怎样让作者比较差异并选择下一步？这涉及另一条数据来源，先保留问题，不把它藏进“最后写入覆盖”的默认行为。'
      )
    ])
  },
  {
    id: 'reading-attention',
    title: '阅读笔记 · 好的留白，给思考留余地',
    folder: '阅读与摘录',
    description: '关于阅读节奏、信息层级和工作记忆的一次整理，附三个可验证的小练习。',
    updatedAt: '2026-04-15T20:18:00+08:00',
    document: document([
      heading('h1', '好的留白，给思考留余地'),
      paragraph('阅读笔记 · 界面与注意力'),
      paragraph(
        '这不是对某一本书的逐字摘录，而是把近期读到的排版与认知材料整理成几条自己的理解。引用样式中的句子也是本次写下的思考，后续可以继续修订。'
      ),
      landscape('把空间留给内容，也留给还没有形成句子的想法。'),
      heading('h2', '一 · 留白是一种关系'),
      paragraph(
        '一段正文周围的距离，会影响我们如何理解它与前后内容的关系。标题离下一段太远，看起来像独立的宣言；几段材料挤在一起，又容易被误认为同一件事。留白首先承担分组和节奏的工作，其次才是风格。'
      ),
      quote('读者不需要同时看见所有入口。需要的是在想继续时，知道下一步在哪里。'),
      paragraph(
        '把这句话放到编辑器里，意味着常驻工具应当有充分理由。我们可以让正文成为稳定的参照，再根据选择和位置呈现相关动作。关键不是藏得多，而是出现的位置是否容易理解。'
      ),
      heading('h2', '二 · 突出少量真正重要的内容'),
      list('bullet', [
        item(
          text('粗体', BOLD),
          '适合句子里的核心判断；一段里有一两个重点，通常比整段加粗更有用。'
        ),
        item(text('斜体', ITALIC), '可以留给语气与补充说明，让它与必须执行的决定保持距离。'),
        item(text('高亮', HIGHLIGHT), '意味着需要回看；处理之后应当允许撤掉，而不是永久积累。'),
        item('颜色不能独自承担状态含义。文字、形状或位置也应当提供线索。')
      ]),
      heading('h3', '一个容易忽略的细节'),
      paragraph(
        '短内容和长内容需要一起看。短笔记容易让宽松排版显得漂亮，真正的长文却会暴露段落节奏、目录定位和复杂内容的边界。评价一次排版，至少应该从开头读到一处表格，再回到前面修改一句话。'
      ),
      heading('h2', '三 · 把理解变成小练习'),
      list('number', [
        item('删去页面上暂时用不到的说明，观察是否还能理解如何开始。'),
        item('只调整标题前后的距离，检查分组是否更清晰。'),
        item('用键盘走一遍相同路径，确认视觉层级也能对应到操作顺序。')
      ]),
      paragraph(
        '练习时记录具体变化：读到哪一行停住、在哪个位置寻找工具、返回正文需要几次操作。不要只写“更高级”或“更有呼吸感”，这些描述很难帮助下一轮修改。'
      ),
      rule(),
      heading('h3', '继续读'),
      paragraph(
        '可作为后续入口：',
        link('W3C 的可访问性入门', 'https://www.w3.org/WAI/fundamentals/accessibility-intro/'),
        '。阅读时留意一个问题：我们认为“显而易见”的操作，是否依赖了某种默认的视觉或输入习惯？'
      ),
      paragraph(
        text('下次实验：', UNDERLINE),
        '找一篇已经熟悉的长文，只改变段落间距与栏宽，分别记录阅读和修改时的感受。先观察，再决定。'
      )
    ])
  },
  {
    id: 'format-field-guide',
    title: '格式巡检 · 一篇能反复编辑的笔记',
    folder: '参考资料',
    description: '用于检查排版与编辑细节的工作样本，涵盖长链接、混排、嵌套任务与公式。',
    updatedAt: '2026-04-14T14:26:00+08:00',
    document: document([
      heading('h1', '一篇能反复编辑的笔记'),
      paragraph('格式巡检 · 编辑器工作样本'),
      paragraph(
        '这篇短文用来在一次调整后快速走查：阅读、选择、修改，再离开后回来。每一项都应当能继续编辑；保存的仍然是同一份文档结构。'
      ),
      heading('h2', '文字的层次'),
      paragraph(
        '正文保持自然的节奏，',
        text('重要判断使用粗体', BOLD),
        '，',
        text('补充语气使用斜体', ITALIC),
        '；',
        text('已放弃的旧想法保留删除线', STRIKE),
        '，',
        text('需要回看的一句加上高亮', HIGHLIGHT),
        '，',
        text('明确约定可以划线', UNDERLINE),
        '。行内的 ',
        text('editor.getEditorState()', CODE),
        ' 与中文之间留出合理的间隔。'
      ),
      paragraph(
        '混排样本：Mica Notebook / Lexical，版本 v1.0；括号（中文）与 parentheses (English)，路径 ',
        text('packages/mica-editor/runtime', CODE),
        '，以及数字 0、12.5 和 100%。这些细节会在窄栏与不同字体下影响阅读。'
      ),
      paragraph(
        '链接检查：',
        link('查看可访问性实践', 'https://www.w3.org/WAI/'),
        '。较长的地址也应当在可读的位置折行：',
        link(
          'https://example.com/research/notebook/reading-and-writing?view=compact&source=notes',
          'https://example.com/research/notebook/reading-and-writing?view=compact&source=notes'
        ),
        '。'
      ),
      heading('h3', '列表与层级'),
      list('bullet', [
        item('先把一次操作写清楚。'),
        nested(
          list('bullet', [
            item('补上触发条件和预期结果。'),
            nested(list('bullet', [item('再补充一个容易被忽略的边界情况。')])),
            item('回到上一层，继续整理。')
          ])
        ),
        item('结束列表后，下一段正文仍应保持正常的间距。')
      ]),
      list('check', [
        task(true, '已完成的项目保留记录。'),
        task(false, '待完成的项目可以直接勾选。'),
        nested(
          list('check', [
            task(false, '子任务单独记录检查结果。'),
            task(true, '已核对一次键盘操作。')
          ])
        ),
        task(false, '较长的一项任务会在换行后继续对齐正文，避免复选框打断句子的阅读节奏。')
      ]),
      heading('h2', '表格和代码'),
      table([
        ['内容', '需要检查', '预期表现'],
        ['表头', '选择与对齐', '标题清晰'],
        ['普通单元格', '换行与复制', '不丢文字'],
        ['长单元格', '内容超过列宽时', '自然折行或滚动'],
        ['空格与标点', '中文 / English 混排', '保持原样'],
        ['编辑结束', '返回表格外继续输入', '焦点明确']
      ]),
      code(
        'typescript',
        'const nextRevision = (current: number): number => {\n  if (!Number.isInteger(current)) {\n    throw new Error("revision must be an integer");\n  }\n  return current + 1;\n};'
      ),
      quote(
        '在引用里补一条背景：表格和代码属于正文的一部分。它们可以有自己的边界，但不应打断整篇文档的阅读关系。'
      ),
      heading('h2', '公式与结尾'),
      paragraph(
        '行内公式 ',
        equation('a^2 + b^2 = c^2', true),
        ' 可以放在一句话里。独立公式用来承接前面的推导：'
      ),
      equation('\\bar{x} = \\frac{1}{n} \\sum_{i=1}^{n} x_i'),
      paragraph(
        '这里仅检查排版与往返保存：数学符号应当有自己的基线，公式前后仍然可以继续输入和移动光标。'
      ),
      rule(),
      paragraph(
        '走查结束后，在这里追加一句话，再切换到另一篇笔记并返回。确认最后的输入仍在，就完成了这一轮检查。'
      )
    ])
  }
]

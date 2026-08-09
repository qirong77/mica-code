const MAX_LOGICAL_LINE_LENGTH = 4096

// Explicit paths and common compiler/test output paths. Bare words are excluded
// so normal terminal output does not trigger filesystem checks on every hover.
const FILE_LINK_PATTERN =
  /(?:^|[\s([{'"`])((?:(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|\/)[^\s'"`<>|:()]+|(?:[\w@+.-]+[\\/])+[\w@+.-]+))(?::(\d+)(?::(\d+))?|\((\d+)(?:,(\d+))?\))?(?=$|[\s)\]},;'"`])/g

function hasOpenModifier(event, platform) {
  return platform === 'darwin' ? event.metaKey : event.ctrlKey
}

function getLogicalLine(terminal, bufferLineNumber) {
  const buffer = terminal.buffer.active
  let firstLine = bufferLineNumber - 1
  let line = buffer.getLine(firstLine)
  if (!line) return null

  while (line?.isWrapped && firstLine > 0) {
    firstLine -= 1
    line = buffer.getLine(firstLine)
  }

  let text = ''
  for (let index = firstLine; index < buffer.length; index += 1) {
    const current = buffer.getLine(index)
    if (!current || (index > firstLine && !current.isWrapped)) break
    text += current.translateToString(true)
    if (text.length >= MAX_LOGICAL_LINE_LENGTH) break
  }

  return { firstLine, text }
}

function mapStringIndex(terminal, lineIndex, columnIndex, stringOffset) {
  const buffer = terminal.buffer.active
  const cell = buffer.getNullCell()
  let line = lineIndex
  let column = columnIndex
  let remaining = stringOffset

  while (remaining > 0) {
    const bufferLine = buffer.getLine(line)
    if (!bufferLine) return null

    for (; column < bufferLine.length; column += 1) {
      bufferLine.getCell(column, cell)
      if (!cell.getWidth()) continue
      remaining -= cell.getChars().length || 1
      if (column === bufferLine.length - 1 && !cell.getChars()) {
        const nextLine = buffer.getLine(line + 1)
        if (nextLine?.isWrapped) {
          nextLine.getCell(0, cell)
          if (cell.getWidth() === 2) remaining += 1
        }
      }
      if (remaining < 0) return { line, column }
    }
    line += 1
    column = 0
  }

  return { line, column }
}

function findFileLinks(text) {
  const matches = []
  const regex = new RegExp(FILE_LINK_PATTERN.source, FILE_LINK_PATTERN.flags)
  let match

  while ((match = regex.exec(text))) {
    const rawPath = match[1]
    const path = rawPath.replace(/[),;!?]+$/, '')
    const prefixLength = match[0].indexOf(rawPath)
    const line = match[2] || match[4] || null
    const column = match[3] || match[5] || null
    const locationLength = line
      ? match[2]
        ? `:${line}${column ? `:${column}` : ''}`.length
        : `(${line}${column ? `,${column}` : ''})`.length
      : 0
    matches.push({
      path,
      line,
      column,
      text: `${path}${
        line
          ? match[2]
            ? `:${line}${column ? `:${column}` : ''}`
            : `(${line}${column ? `,${column}` : ''})`
          : ''
      }`,
      startIndex: match.index + prefixLength,
      length: path.length + locationLength
    })
  }

  return matches
}

export function createFileLinkProvider(terminal, terminalId, platform) {
  return {
    provideLinks(bufferLineNumber, callback) {
      const logicalLine = getLogicalLine(terminal, bufferLineNumber)
      if (!logicalLine) {
        callback(undefined)
        return
      }

      const matches = findFileLinks(logicalLine.text)
      if (!matches.length) {
        callback(undefined)
        return
      }

      window.mica.terminal
        .resolveFileLinks(terminalId, [...new Set(matches.map((match) => match.path))])
        .then((validPaths) => {
          const currentLine = getLogicalLine(terminal, bufferLineNumber)
          if (
            !currentLine ||
            currentLine.firstLine !== logicalLine.firstLine ||
            currentLine.text !== logicalLine.text
          ) {
            callback(undefined)
            return
          }
          const valid = new Set(validPaths)
          const links = []

          for (const match of matches) {
            if (!valid.has(match.path)) continue
            const start = mapStringIndex(terminal, logicalLine.firstLine, 0, match.startIndex)
            if (!start) continue
            const end = mapStringIndex(terminal, start.line, start.column, match.length)
            if (!end) continue

            links.push({
              text: match.text,
              range: {
                start: { x: start.column + 1, y: start.line + 1 },
                end: { x: end.column, y: end.line + 1 }
              },
              activate(event) {
                if (!hasOpenModifier(event, platform)) return
                event.preventDefault()
                window.mica.terminal
                  .openFile(terminalId, match.path, match.line, match.column)
                  .catch((error) => console.error('open terminal file link failed', error))
              }
            })
          }

          callback(links.length ? links : undefined)
        })
        .catch((error) => {
          console.error('resolve terminal file links failed', error)
          callback(undefined)
        })
    }
  }
}

export function openWebLink(event, url, platform) {
  if (!hasOpenModifier(event, platform)) return
  event.preventDefault()
  window.mica.terminal
    .openExternal(url)
    .catch((error) => console.error('open terminal web link failed', error))
}

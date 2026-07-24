export function createSubmittedCommandTracker(onCommand) {
  let line = ''

  return (data) => {
    for (const character of data) {
      if (character === '\r' || character === '\n') {
        if (line.trim()) onCommand(line.trim())
        line = ''
      } else if (character === '\x7f' || character === '\b') {
        line = line.slice(0, -1)
      } else if (character === '\x15') {
        line = ''
      } else if (character >= ' ' && character !== '\x7f') {
        line += character
      }
    }
  }
}

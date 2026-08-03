export function toWellFormedText(text: string): string {
  let result = '';
  let changed = false;

  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += text[index] + text[index + 1];
        index++;
      } else {
        result += '\ufffd';
        changed = true;
      }
      continue;
    }

    if (code >= 0xdc00 && code <= 0xdfff) {
      result += '\ufffd';
      changed = true;
      continue;
    }

    result += text[index];
  }

  return changed ? result : text;
}

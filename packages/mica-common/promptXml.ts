/** Escape arbitrary text used as XML data (including attribute values). */
export function escapePromptXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Wrap authored prompt content, preserving inner XML but reserving the outer tag. */
export function wrapPromptXml(tag: string, content: string, attributes: Record<string, string> = {}): string {
  if (!/^[a-z][a-z0-9_-]*$/.test(tag)) throw new Error(`Invalid prompt tag: ${tag}`);
  const attrs = Object.entries(attributes)
    .map(([key, value]) => {
      if (!/^[a-z][a-z0-9_-]*$/.test(key)) throw new Error(`Invalid prompt attribute: ${key}`);
      return ` ${key}="${escapePromptXml(value)}"`;
    })
    .join('');
  const body = content.trim().replace(new RegExp(`<\\/?${tag}(?=[\\s/>])[^>]*>`, 'gi'), escapePromptXml);
  return `<${tag}${attrs}>\n${body}\n</${tag}>`;
}

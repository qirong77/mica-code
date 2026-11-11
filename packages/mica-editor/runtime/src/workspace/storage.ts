/** Count visible non-whitespace Unicode characters, not UTF-16 code units. */
export function countCharacters(text: string): number {
  return Array.from(text.replace(/\s/g, '')).length;
}

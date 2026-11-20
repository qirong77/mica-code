import {describe, expect, it} from 'vitest';

import {EMOJI_ALIASES} from '../src/playground/utils/emoji-aliases';
import emojiList from '../src/playground/utils/emoji-list';

describe('emoji alias projection', () => {
  it('keeps the compact Markdown shortcut map aligned with the picker data', () => {
    const aliases = new Set<string>();
    for (const item of emojiList) {
      for (const alias of item.aliases ?? []) {
        aliases.add(alias);
        expect(EMOJI_ALIASES[alias]).toBe(item.emoji);
      }
    }
    expect(Object.keys(EMOJI_ALIASES)).toHaveLength(aliases.size);
  });
});

import { describe, expect, it } from 'vitest';
import { imageOmittedPlaceholder } from './imagePlaceholder.js';

describe('imageOmittedPlaceholder', () => {
  it('explains the omission to the user and instructs the model to state it', () => {
    const text = imageOmittedPlaceholder('text-model');
    expect(text).toContain('text-model');
    expect(text).toContain('不支持图片输入');
    expect(text).toContain('告知用户');
    expect(text).not.toContain('data:image');
  });
});

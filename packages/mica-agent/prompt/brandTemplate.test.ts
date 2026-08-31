import { describe, expect, it } from 'vitest';
import { APP_NAME, CONFIG_DIR_NAME, RUNTIME_NAME, VERSION_LABEL } from '@packages/mica-config/brand.js';
import { applyBrandTemplate } from './brandTemplate.js';

describe('brand template expansion', () => {
  it('replaces known brand placeholders', () => {
    const input = '{{ MICA_APP_NAME }} | {{ MICA_RUNTIME_NAME }} | {{ MICA_VERSION_LABEL }} | {{ MICA_CONFIG_DIR_NAME }}';
    expect(applyBrandTemplate(input)).toBe(`${APP_NAME} | ${RUNTIME_NAME} | ${VERSION_LABEL} | ${CONFIG_DIR_NAME}`);
  });

  it('accepts compact placeholders without spaces', () => {
    expect(applyBrandTemplate('{{MICA_APP_NAME}}')).toBe(APP_NAME);
  });

  it('leaves unknown placeholders untouched', () => {
    expect(applyBrandTemplate('{{ UNKNOWN_KEY }}')).toBe('{{ UNKNOWN_KEY }}');
  });

  it('renders the default agent identity used by system.md', () => {
    expect(applyBrandTemplate('你是 {{ MICA_APP_NAME }}，一个轻量级编程辅助工具（CLI）。')).toBe(
      `你是 ${APP_NAME}，一个轻量级编程辅助工具（CLI）。`,
    );
  });
});

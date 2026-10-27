import { describe, expect, it } from 'vitest';
import { parsePluginManifest } from './PluginManifest.js';

function base(extra: Record<string, unknown> = {}) {
  return { id: 'demo', name: 'Demo', version: '1.0.0', ...extra };
}

describe('parsePluginManifest desktop checks', () => {
  it('reads the declared run requirements in declaration order', () => {
    const result = parsePluginManifest(
      base({ desktop: { checks: ['screen-recording', 'accessibility'] } }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.desktopChecks).toEqual(['screen-recording', 'accessibility']);
  });

  it('defaults to no checks when the plugin declares nothing', () => {
    const result = parsePluginManifest(base());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.desktopChecks).toEqual([]);
  });

  it('rejects unknown check ids so a broken manifest shows up in the config page', () => {
    const unknownCheck = parsePluginManifest(base({ desktop: { checks: ['telepathy'] } }));
    expect(unknownCheck.ok).toBe(false);
    if (!unknownCheck.ok) expect(unknownCheck.error).toContain('未知检查项');

    const notArray = parsePluginManifest(base({ desktop: { checks: 'accessibility' } }));
    expect(notArray.ok).toBe(false);
    if (!notArray.ok) expect(notArray.error).toContain('必须是数组');
  });

  it('dedupes repeated check ids instead of rendering the row twice', () => {
    const result = parsePluginManifest(base({ desktop: { checks: ['accessibility', 'accessibility'] } }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.desktopChecks).toEqual(['accessibility']);
  });
});

describe('parsePluginManifest requirements', () => {
  it('accepts the skills and desktop capability names', () => {
    const result = parsePluginManifest(base({ requires: ['skills', 'desktop', 'settings'] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.requires).toEqual(['skills', 'desktop', 'settings']);
  });

  it('rejects capability names the host can never provide', () => {
    const result = parsePluginManifest(base({ requires: ['teleport'] }));
    expect(result.ok).toBe(false);
  });
});

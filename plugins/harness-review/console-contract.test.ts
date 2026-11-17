import { describe, expect, it } from 'vitest';
import { parsePluginManifest } from '@packages/mica-plugin/PluginManifest.js';
import { pluginPagePath } from '@packages/mica-web-shared/app-paths.js';
import manifest from './plugin.json';

describe('Harness console declaration', () => {
  it('registers the named page and independent web module without gating CLI capture on desktop', () => {
    const parsed = parsePluginManifest(manifest);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.manifest.web).toBe(true);
    expect(parsed.manifest.desktopPage).toEqual({ title: '运行控制台', route: 'console' });
    expect(parsed.manifest.desktopEntry).toBeNull();
    expect(parsed.manifest.requires).not.toContain('desktop');
    expect(pluginPagePath(parsed.manifest.id, parsed.manifest.desktopPage?.route)).toBe(
      '/plugins/harness-review/console',
    );
  });
});

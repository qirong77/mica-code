import { describe, expect, it } from 'vitest';
import { officialPluginIds, officialPluginManifests } from './manifests.js';

describe('official plugin manifests', () => {
  it('keeps ids unique', () => {
    expect(officialPluginIds.size).toBe(officialPluginManifests.length);
  });

  it('declares a version, description and entry for every plugin', () => {
    for (const manifest of officialPluginManifests) {
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(manifest.description.trim()).not.toBe('');
      expect(manifest.main.trim()).not.toBe('');
      expect(manifest.apiVersion).toBe(1);
    }
  });

  it('ships at least the todo plugin', () => {
    expect([...officialPluginIds]).toContain('todo');
  });
  it('registers session experience plugins with desktop panels and optional local telemetry', () => {
    for (const id of ['task-delivery', 'context-handoff', 'environment-ready']) {
      const manifest = officialPluginManifests.find((entry) => entry.id === id)!;
      expect(manifest).toBeDefined();
      expect(manifest.requires).toContain('desktop');
      expect(manifest.desktopPanel?.dynamicShortcuts).toBe(true);
      expect(manifest.settings.find((setting) => setting.key === 'telemetry')).toMatchObject({
        type: 'switch',
        default: 'true',
      });
    }
  });
});

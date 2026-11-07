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
  it('does not register the removed task delivery plugin', () => {
    expect(officialPluginIds.has('task-delivery')).toBe(false);
  });
  it('does not register the removed voice input plugin', () => {
    expect(officialPluginIds.has('voice-input')).toBe(false);
  });
  it('does not register the removed context handoff plugin', () => {
    expect(officialPluginIds.has('context-handoff')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { officialPluginManifests, officialPlugins } from './index.js';

describe('official plugin registration', () => {
  it('wires every manifest to a setup function', () => {
    expect(officialPlugins.map((plugin) => plugin.id)).toEqual(officialPluginManifests.map((manifest) => manifest.id));
    for (const plugin of officialPlugins) {
      expect(typeof plugin.setup).toBe('function');
      expect(plugin.manifest?.id).toBe(plugin.id);
      expect(plugin.name).toBe(plugin.manifest?.name);
    }
  });

  it('keeps manifest flags on the registered plugin', () => {
    const todo = officialPlugins.find((plugin) => plugin.id === 'todo');
    expect(todo).toMatchObject({ version: '1.0.0', required: true });
  });
});

import { describe, expect, it } from 'vitest';
import { officialPluginManifests } from '../../mica-official-plugins/manifests.js';
import { DEFAULT_PLUGIN_ICON, PLUGIN_ICONS, resolvePluginIcon } from './pluginIcons.js';

/**
 * 图标表的两个约束：官方插件声明的名字必须真的解析得到（清单写错一个字母，界面上只会
 * 悄悄退成同一个默认图标），以及不认识的名称要有确定的兜底。
 */
describe('plugin icons', () => {
  it('resolves the icon every official plugin declares', () => {
    for (const manifest of officialPluginManifests) {
      expect(manifest.icon, `${manifest.id} 没在 plugin.json 里声明 icon`).toBeTruthy();
      expect(
        PLUGIN_ICONS[manifest.icon as keyof typeof PLUGIN_ICONS],
        `${manifest.id}: ${manifest.icon}`,
      ).toBeDefined();
    }
  });

  it('falls back to the default icon for names nobody registered', () => {
    expect(resolvePluginIcon('nope-not-a-plugin-icon')).toBe(PLUGIN_ICONS[DEFAULT_PLUGIN_ICON]);
    expect(resolvePluginIcon('')).toBe(PLUGIN_ICONS[DEFAULT_PLUGIN_ICON]);
    expect(resolvePluginIcon(undefined)).toBe(PLUGIN_ICONS[DEFAULT_PLUGIN_ICON]);
  });

  it('resolves a registered name to its own component', () => {
    expect(resolvePluginIcon('list-checks')).toBe(PLUGIN_ICONS['list-checks']);
  });
});

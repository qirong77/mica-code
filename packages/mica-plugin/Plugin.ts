import type { Disposable } from '@packages/mica-common/index.js';
import type { PluginManifest } from './PluginManifest.js';
import type { PluginContext } from './PluginContext.js';

export type MicaPlugin = {
  id: string;
  name?: string;
  version?: string;
  priority?: number;
  dependencies?: string[];
  required?: boolean;
  /** 插件包的清单；内置插件为 undefined（它们没有 plugin.json 文件）。 */
  manifest?: PluginManifest;
  setup(ctx: PluginContext): void | Disposable | Promise<void | Disposable>;
};

export abstract class Plugin implements MicaPlugin {
  readonly id: string;
  readonly name?: string;
  readonly version?: string;
  readonly priority?: number;
  readonly dependencies?: string[];
  readonly required?: boolean;
  readonly manifest?: PluginManifest;

  protected constructor(options: {
    id: string;
    name?: string;
    version?: string;
    priority?: number;
    dependencies?: string[];
    required?: boolean;
    manifest?: PluginManifest;
  }) {
    this.id = options.id;
    this.name = options.name;
    this.version = options.version;
    this.priority = options.priority;
    this.dependencies = options.dependencies;
    this.required = options.required;
    this.manifest = options.manifest;
  }

  abstract setup(ctx: PluginContext): void | Disposable | Promise<void | Disposable>;
}

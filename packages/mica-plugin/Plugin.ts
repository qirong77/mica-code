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
  /**
   * 插件目录的绝对路径；编译进产物的内置插件没有它。
   *
   * 清单里的相对声明（`skills`、随包资源）以它为根解析——「随插件一起走」的东西必须
   * 知道插件自己落在哪儿。
   */
  root?: string;
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
  readonly root?: string;

  protected constructor(options: {
    id: string;
    name?: string;
    version?: string;
    priority?: number;
    dependencies?: string[];
    required?: boolean;
    manifest?: PluginManifest;
    root?: string;
  }) {
    this.id = options.id;
    this.name = options.name;
    this.version = options.version;
    this.priority = options.priority;
    this.dependencies = options.dependencies;
    this.required = options.required;
    this.manifest = options.manifest;
    this.root = options.root;
  }

  abstract setup(ctx: PluginContext): void | Disposable | Promise<void | Disposable>;
}

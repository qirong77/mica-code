import type { Disposable } from '@packages/mica-common/index.js';
import type { PluginContext } from './PluginContext.js';

export type MicaPlugin = {
  id: string;
  name?: string;
  version?: string;
  priority?: number;
  dependencies?: string[];
  required?: boolean;
  setup(ctx: PluginContext): void | Disposable | Promise<void | Disposable>;
};

export abstract class Plugin implements MicaPlugin {
  readonly id: string;
  readonly name?: string;
  readonly version?: string;
  readonly priority?: number;
  readonly dependencies?: string[];
  readonly required?: boolean;

  protected constructor(options: {
    id: string;
    name?: string;
    version?: string;
    priority?: number;
    dependencies?: string[];
    required?: boolean;
  }) {
    this.id = options.id;
    this.name = options.name;
    this.version = options.version;
    this.priority = options.priority;
    this.dependencies = options.dependencies;
    this.required = options.required;
  }

  abstract setup(ctx: PluginContext): void | Disposable | Promise<void | Disposable>;
}

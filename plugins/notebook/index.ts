import type { PluginContext } from '@packages/mica-plugin/index.js';

/**
 * The Notebook page is a desktop asset and its MCP endpoint is assembled by the
 * plugin MCP host. The ordinary plugin setup remains intentionally empty: there
 * is no second session-tool or skill registration path.
 */
export default function setup(_ctx: PluginContext): void {}

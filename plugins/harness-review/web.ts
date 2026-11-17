import type { PluginWebContext, PluginWebHandler } from '@packages/mica-plugin/PluginWeb.js';
import { HarnessConsoleService } from './console.js';

/** Same-port read-only endpoint; no setup, session, recorder hooks or mutation queries. */
export default function createWeb(context: PluginWebContext): PluginWebHandler {
  const service = new HarnessConsoleService(context);
  return {
    queries: {
      snapshot(params, { signal }) {
        if (Object.keys(params).length !== 0)
          throw new Error('Harness console snapshot does not accept query parameters.');
        return service.snapshot(signal);
      },
    },
    dispose: () => service.dispose(),
  };
}

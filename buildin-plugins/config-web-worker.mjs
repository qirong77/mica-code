import { isConfigWebWorker } from '../packages/mica-config-web/src/server/workerArgs.js';

/**
 * Starts Config Web when this process was spawned in worker mode. The server
 * implementation is imported lazily so normal CLI startup does not initialize
 * Config Web, and worker startup does not initialize the terminal application.
 */
export default async function startConfigWebWorker(ctx = {}) {
  if (!isConfigWebWorker(ctx.argv ?? process.argv)) return false;

  const startServer = ctx.startServer ?? defaultStartServer;
  await startServer();
  return true;
}

async function defaultStartServer() {
  const { startConfigWebServer } = await import('../packages/mica-config-web/src/server/server.js');
  return startConfigWebServer({});
}

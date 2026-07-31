import { startSyncServer } from './server.js';

const DEFAULT_PORT = 5560;
const DEFAULT_DATA_DIR = './data';

function parseArg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  const prefix = `${name}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const port = Number(parseArg(argv, '--port') ?? process.env.MICA_SYNC_PORT ?? DEFAULT_PORT);
  const dataDir = parseArg(argv, '--data-dir') ?? process.env.MICA_SYNC_DATA_DIR ?? DEFAULT_DATA_DIR;
  const webDir = parseArg(argv, '--web-dir') ?? process.env.MICA_SYNC_WEB_DIR;

  const running = await startSyncServer({ port, dataDir, webDir });
  console.log(`mica-sync-server listening on http://0.0.0.0:${running.port}`);
  console.log(`  data dir: ${dataDir}`);
  if (webDir) console.log(`  web assets: ${webDir}`);
  console.log('  register a machine:  mica daemon --server http://HOST:PORT');

  const shutdown = () => {
    void running.stop().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

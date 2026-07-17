export function isConfigWebWorker(argv: readonly string[] = process.argv): boolean {
  return argv.includes('--config-web-worker');
}

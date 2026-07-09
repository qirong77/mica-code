export function getConfigWebWorkerToken(argv: readonly string[] = process.argv): string | null {
  const workerArgIndex = argv.indexOf('--config-web-worker');
  if (workerArgIndex === -1) return null;

  const token = argv[workerArgIndex + 1];
  if (!token) throw new Error('Missing config web token');
  return token;
}

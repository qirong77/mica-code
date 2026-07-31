// Re-exports the Node-side PTY server source as a string so the Bun host can
// materialize it at runtime (dev, headless, and the compiled single binary all
// resolve the same copy). The server runs under `node`, never inside Bun.
import serverSource from './server.mjs?raw';

export const ptyServerSource: string = serverSource;

import { startConfigWebServer } from './server.js';

const token = process.argv[2];
if (!token) throw new Error('Missing config web token');

await startConfigWebServer({ token });

await new Promise(() => undefined);

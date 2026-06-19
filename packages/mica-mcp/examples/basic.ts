import { micaMcp } from '../index.js';

console.log(`MCP config path: ${micaMcp.configPath}`);
console.log(`Configured servers: ${micaMcp.servers.get().length}`);

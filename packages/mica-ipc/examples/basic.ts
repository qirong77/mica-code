import { micaIpc } from '../index.js';

console.log(`${micaIpc.protocol}@${micaIpc.version}`);

// A real IPC demo needs two processes:
// const server = new micaIpc.AgentIpcServer({ agentId, socketPath, runtime });
// const client = new micaIpc.AgentIpcClient(socketPath);

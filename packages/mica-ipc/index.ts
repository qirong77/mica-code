import { AgentIpcClient } from './AgentIpcClient.js';
import { AgentIpcServer } from './AgentIpcServer.js';
import { ControlLock } from './ControlLock.js';
import { JsonLineConnection } from './jsonLine.js';
import { MICA_AGENT_RPC_PROTOCOL, MICA_AGENT_RPC_VERSION } from './protocol.js';

export const micaIpc = {
  AgentIpcClient,
  AgentIpcServer,
  ControlLock,
  JsonLineConnection,
  protocol: MICA_AGENT_RPC_PROTOCOL,
  version: MICA_AGENT_RPC_VERSION,
};

export type {
  AttachParams,
  AttachResult,
  HelloParams,
  HelloResult,
  RpcError,
  RpcEvent,
  RpcMessage,
  RpcRequest,
  RpcResponse,
  RuntimeRpcMethods,
} from './protocol.js';
export type { ControlState } from './ControlLock.js';

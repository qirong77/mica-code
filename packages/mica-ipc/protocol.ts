import type { RuntimeViewSnapshot, SubmitResult, AbortResult } from '@packages/mica-runtime/index.js';

export const MICA_AGENT_RPC_PROTOCOL = 'mica-agent-rpc';
export const MICA_AGENT_RPC_VERSION = 1;

export type RpcRequest = {
  type: 'request';
  id: string;
  method: string;
  params?: unknown;
};

export type RpcResponse = {
  type: 'response';
  id: string;
  result?: unknown;
  error?: RpcError;
};

export type RpcEvent = {
  type: 'event';
  event: string;
  seq: number;
  payload?: unknown;
};

export type RpcMessage = RpcRequest | RpcResponse | RpcEvent;

export type RpcError = {
  code: string;
  message: string;
  data?: unknown;
};

export type HelloParams = {
  protocol: typeof MICA_AGENT_RPC_PROTOCOL;
  protocolVersion: typeof MICA_AGENT_RPC_VERSION;
  clientAgentId: string;
  clientPid: number;
  clientCwd: string;
};

export type HelloResult = {
  agentId: string;
  protocolVersion: typeof MICA_AGENT_RPC_VERSION;
  serverPid: number;
};

export type AttachParams = {
  mode: 'control' | 'observe';
  takeover?: boolean;
  controllerAgentId: string;
  controllerPid: number;
  controllerCwd: string;
};

export type AttachResult = {
  attached: boolean;
  mode: 'control' | 'observe';
  snapshot: RuntimeViewSnapshot;
};

export type RuntimeRpcMethods = {
  hello(params: HelloParams): Promise<HelloResult>;
  getState(): Promise<RuntimeViewSnapshot>;
  attach(params: AttachParams): Promise<AttachResult>;
  detach(params: { controllerAgentId: string; controllerPid: number }): Promise<{ detached: true }>;
  submit(params: { text: string }): Promise<SubmitResult>;
  abort(params?: { reason?: string }): Promise<AbortResult>;
};

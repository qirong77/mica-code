import { micaRuntime, type AbortResult, type RuntimeController, type RuntimeStatus, type RuntimeViewSnapshot, type SubmitOptions, type SubmitResult } from '@packages/mica-runtime/index.js';
import { micaIpc } from '@packages/mica-ipc/index.js';

export class RemoteRuntimeClientAdapter implements RuntimeController {
  readonly events = new micaRuntime.RuntimeEventBus();

  constructor(
    private readonly client: InstanceType<typeof micaIpc.AgentIpcClient>,
    private snapshot: RuntimeViewSnapshot,
    private readonly controllerAgentId: string,
  ) {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    await this.client.detach(this.controllerAgentId).catch(() => undefined);
    this.client.close();
  }

  async submit(text: string, _options: SubmitOptions = {}): Promise<SubmitResult> {
    return (await this.client.submit(text)) as SubmitResult;
  }

  async abort(reason?: string): Promise<AbortResult> {
    return (await this.client.abort(reason)) as AbortResult;
  }

  getStatus(): RuntimeStatus {
    return this.snapshot.status;
  }

  getSnapshot(): RuntimeViewSnapshot {
    return this.snapshot;
  }

  updateSnapshot(snapshot: RuntimeViewSnapshot): void {
    this.snapshot = snapshot;
  }
}

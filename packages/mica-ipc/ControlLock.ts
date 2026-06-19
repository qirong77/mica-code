export type ControlState = {
  mode: 'local' | 'remote-controlled';
  controllerAgentId?: string;
  controllerPid?: number;
  controllerCwd?: string;
  attachedAt?: string;
};

export class ControlLock {
  private state: ControlState = { mode: 'local' };

  getState(): ControlState {
    return { ...this.state };
  }

  attach(params: {
    controllerAgentId: string;
    controllerPid: number;
    controllerCwd: string;
    takeover?: boolean;
  }): ControlState {
    if (this.state.mode === 'remote-controlled' && !params.takeover) {
      throw new Error('Agent is already controlled by another controller');
    }
    this.state = {
      mode: 'remote-controlled',
      controllerAgentId: params.controllerAgentId,
      controllerPid: params.controllerPid,
      controllerCwd: params.controllerCwd,
      attachedAt: new Date().toISOString(),
    };
    return this.getState();
  }

  detach(controllerAgentId: string, controllerPid: number): ControlState {
    if (
      this.state.mode === 'remote-controlled' &&
      this.state.controllerAgentId === controllerAgentId &&
      this.state.controllerPid === controllerPid
    ) {
      this.state = { mode: 'local' };
    }
    return this.getState();
  }
}

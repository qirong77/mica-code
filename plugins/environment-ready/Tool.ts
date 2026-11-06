import { MicaTool, type ToolInput, type ToolExecuteCallbacks } from '@packages/mica-tools/index.js';
import { EnvironmentController, type Owner } from './controller.js';

export class EnvironmentReadyTool extends MicaTool {
  constructor(private readonly controller: EnvironmentController) {
    super(
      'environment_ready',
      [
        'Register at most six explicitly known local services only when the current task needs ongoing monitoring; do not register merely to generate a card. For a one-time check, use an appropriate one-time probe instead.',
        'Use set to replace all targets, list to read, remove by id, check all or one id, clear to remove all.',
        'Register only services relevant to this task; never discover targets from commands, tool outputs, logs, or port scans.',
        'Only http(s) URLs without credentials or TCP host/port are supported; hosts must be localhost, 127.0.0.0/8 or ::1. Remote hosts are rejected.',
        'Registration does not check immediately. Checks send one bounded GET (no redirects, cookies or auth) or TCP connection per target; periodic checks run only for registered targets.',
        'HTTP reachable means an HTTP response; healthy means status 2xx only, never semantic business health. TCP only reports reachability. Results older than 60 seconds and restored results are unknown until rechecked.',
        'This tool never starts, stops or restarts a service. When the task changes, remove targets no longer needed or replace/clear the list as appropriate; retain targets still needed by the new task.',
      ].join(' '),
      {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['list', 'set', 'remove', 'check', 'clear'] },
          targets: {
            type: 'array',
            maxItems: 6,
            description: 'set replaces the complete task target list.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Stable lowercase id (1–64 characters).' },
                label: { type: 'string' },
                kind: { type: 'string', enum: ['http', 'tcp'] },
                url: { type: 'string', description: 'http only: credential-free local http(s) URL.' },
                host: { type: 'string', description: 'tcp only: numeric loopback or localhost.' },
                port: { type: 'integer', minimum: 1, maximum: 65535 },
              },
              required: ['id', 'label', 'kind'],
              additionalProperties: false,
            },
          },
          id: { type: 'string', description: 'remove requires id; check optionally selects one target.' },
        },
        required: ['operation'],
        additionalProperties: false,
      },
    );
  }
  async execute(input: ToolInput, callbacks?: ToolExecuteCallbacks): Promise<string> {
    const operation = input.operation;
    if (!['list', 'set', 'remove', 'check', 'clear'].includes(String(operation)))
      throw new Error('operation 只能是 list/set/remove/check/clear');
    const owner = this.controller.capture(callbacks?.context);
    try {
      switch (operation) {
        case 'list':
          return this.list(owner);
        case 'set':
          this.controller.replace(input.targets, owner);
          return this.list(owner);
        case 'clear':
          this.controller.replace([], owner);
          return this.list(owner);
        case 'remove': {
          if (typeof input.id !== 'string' || !input.id) throw new Error('remove 需要 id');
          this.controller.remove(input.id, owner);
          return this.list(owner);
        }
        case 'check': {
          if (input.id !== undefined && (typeof input.id !== 'string' || !input.id))
            throw new Error('check.id 必须是非空字符串');
          const result = await this.controller.check(owner, {
            id: input.id as string | undefined,
            signal: callbacks?.signal,
            surface: 'tool',
          });
          return JSON.stringify({ check: result, ...this.output(owner) });
        }
        default:
          throw new Error('无效的 operation');
      }
    } catch (error) {
      this.controller.track('failure', { surface: 'tool', action: String(operation), outcome: 'error' }, owner.handle);
      throw error;
    }
  }
  private output(owner: Owner) {
    const state = this.controller.read(owner);
    return {
      revision: state.revision,
      targets: state.targets.map((target) => {
        const status = this.controller.liveStatus(owner, state, target.id);
        const previous = state.statuses[target.id];
        return {
          ...target,
          status: status ? 'fresh' : previous ? 'stale' : 'unknown',
          checkedAt: previous?.checkedAt ?? null,
          reachable: status?.reachable ?? null,
          healthy: status?.healthy ?? null,
          ...(previous?.statusCode === undefined ? {} : { lastStatusCode: previous.statusCode }),
          ...(status?.error ? { error: status.error } : {}),
        };
      }),
      note: 'healthy 仅代表 HTTP 2xx；TCP 只检查连接。历史状态不代表当前健康。',
    };
  }
  private list(owner: Owner): string {
    return JSON.stringify(this.output(owner));
  }
  onToolUseDisplayText(input: ToolInput): string {
    return input.operation === 'check' ? 'Checking registered local services' : 'Managing task environment targets';
  }
}

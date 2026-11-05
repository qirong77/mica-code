import { MicaTool, type ToolExecuteCallbacks, type ToolInput } from '@packages/mica-tools/index.js';
import { bounded, parseSet, record, type Checkpoint, type CheckpointInput } from './state.js';
export type HandoffAccess = {
  read(context?: unknown): Checkpoint | undefined;
  set(value: CheckpointInput, context?: unknown): Checkpoint;
  clear(context?: unknown): void;
  failure?(): void;
};
export class ContextHandoffTool extends MicaTool {
  constructor(private readonly access: HandoffAccess) {
    super(
      'context_handoff',
      'Read, set or clear a historical handoff checkpoint for this primary session. Save the checkpoint, completed work, pending work and cautions before pausing or handing off. set replaces the whole checkpoint. These are historical model reports, not proof of the current workspace. Do not include secrets or raw outputs. The Continue button only drafts a request to reverify cwd/Git before proceeding; it does not send or run commands.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['read', 'set', 'clear'] },
          checkpoint: { type: 'string', description: 'Required for set; 1–3000 character historical summary.' },
          completed: {
            type: 'array',
            items: { type: 'string' },
            description: 'At most 16 historical completed items, 600 characters each.',
          },
          pending: {
            type: 'array',
            items: { type: 'string' },
            description: 'At most 16 pending items, 600 characters each.',
          },
          cautions: {
            type: 'array',
            items: { type: 'string' },
            description: 'At most 16 constraints or uncertainties, 600 characters each.',
          },
        },
      },
    );
  }
  override validateInput(input: unknown) {
    try {
      parseInput(input);
      return { valid: true };
    } catch {
      return { valid: false, message: 'Invalid context_handoff input; use bounded read/set/clear fields.' };
    }
  }
  async execute(input: ToolInput, callbacks?: ToolExecuteCallbacks): Promise<string> {
    try {
      const parsed = parseInput(input);
      const context = callbacks?.context;
      if (parsed.action === 'read')
        return JSON.stringify({
          source: 'historical-model-report',
          checkpoint: this.access.read(context) ?? null,
          requiresWorkspaceReverification: true,
        });
      if (parsed.action === 'clear') {
        this.access.clear(context);
        return 'Historical handoff checkpoint cleared.';
      }
      const next = this.access.set(parsed.value, context);
      return JSON.stringify({
        revision: next.revision,
        savedAt: next.savedAt,
        sourceSessionId: next.sourceSessionId,
        source: 'historical-model-report',
      });
    } catch (error) {
      this.access.failure?.();
      throw error;
    }
  }
  onToolUseDisplayText(input: ToolInput): string {
    return input.action === 'read' ? 'Reading historical handoff' : 'Updating historical handoff';
  }
}
function parseInput(
  input: unknown,
): { action: 'read' } | { action: 'clear' } | { action: 'set'; value: CheckpointInput } {
  if (!record(input) || !bounded(input)) throw new Error('Input must be a JSON object under 48 KiB.');
  if (input.action === 'set') return { action: 'set', value: parseSet(input) };
  if ((input.action === 'read' || input.action === 'clear') && Object.keys(input).length === 1)
    return { action: input.action };
  throw new Error('Use read, set or clear; read/clear accept only action.');
}

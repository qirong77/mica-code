import { MicaTool, type ToolExecuteCallbacks, type ToolInput } from '@packages/mica-tools/index.js';
import { bounded, parseSet, record, type Delivery, type DeliveryInput } from './state.js';

export type DeliveryAccess = {
  read(context?: unknown): Delivery | undefined;
  set(value: DeliveryInput, context?: unknown): Delivery;
  clear(context?: unknown): void;
  failure?(): void;
};
export class TaskDeliveryTool extends MicaTool {
  constructor(private readonly access: DeliveryAccess) {
    super(
      'task_delivery',
      'Read, set or clear a task delivery report. Use set only for substantive multi-step work with a deliverable needing a handoff, not simple questions, explanations, casual conversation or a single read-only lookup/inspection. All code/validation/build/deploy statuses and validationClaims are MODEL REPORTS, never independently verified. evidenceIds may reference actual tool call IDs observed in this primary runtime owner and current run; unavailable IDs provide no evidence. A returned tool result is not proof that tests passed or deployment succeeded. set replaces the entire report. Do not include secrets or raw tool output.',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['read', 'set', 'clear'] },
          summary: { type: 'string', description: 'Required for set, 1–3000 characters.' },
          changedFiles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Up to 40 paths, 320 characters each. Model reported, not a Git diff.',
          },
          reports: {
            type: 'object',
            additionalProperties: false,
            properties: Object.fromEntries(
              ['code', 'validation', 'build', 'deploy'].map((key) => [
                key,
                { type: 'string', enum: ['unknown', 'pending', 'done', 'failed', 'skipped'] },
              ]),
            ),
            required: ['code', 'validation', 'build', 'deploy'],
          },
          validationClaims: {
            type: 'array',
            items: { type: 'string' },
            description: 'Up to 12 unverified model claims, 600 characters each.',
          },
          deploymentReport: {
            type: 'string',
            description: 'Model reported deployment source/outcome; not independent proof, up to 1500 characters.',
          },
          evidenceIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Up to 12 actual tool call IDs. Missing observations are omitted.',
          },
        },
        required: ['action'],
      },
    );
  }
  override validateInput(input: unknown) {
    try {
      parseInput(input);
      return { valid: true };
    } catch {
      return { valid: false, message: 'Invalid task_delivery input; use bounded read/set/clear fields.' };
    }
  }
  async execute(input: ToolInput, callbacks?: ToolExecuteCallbacks): Promise<string> {
    try {
      const parsed = parseInput(input);
      const context = callbacks?.context;
      if (parsed.action === 'read')
        return JSON.stringify({
          delivery: this.access.read(context) ?? null,
          source: 'historical-model-report',
          evidenceMeaning: 'Stored runtime tool return references; not independent validation or deployment proof.',
        });
      if (parsed.action === 'clear') {
        this.access.clear(context);
        return 'Task delivery cleared.';
      }
      const next = this.access.set(parsed.value, context);
      return JSON.stringify({
        revision: next.revision,
        source: 'model-report',
        observedEvidenceCount: next.evidence.length,
        unavailableEvidenceCount: [...new Set(parsed.value.evidenceIds)].length - next.evidence.length,
      });
    } catch (error) {
      this.access.failure?.();
      throw error;
    }
  }
  onToolUseDisplayText(input: ToolInput): string {
    return input.action === 'read' ? 'Reading task delivery' : 'Updating task delivery';
  }
}
function parseInput(
  input: unknown,
): { action: 'read' } | { action: 'clear' } | { action: 'set'; value: DeliveryInput } {
  if (!record(input) || !bounded(input)) throw new Error('Input must be a JSON object under 48 KiB.');
  if (input.action === 'set') return { action: 'set', value: parseSet(input) };
  if ((input.action === 'read' || input.action === 'clear') && Object.keys(input).length === 1)
    return { action: input.action };
  throw new Error('Use read, set or clear; read/clear accept only action.');
}

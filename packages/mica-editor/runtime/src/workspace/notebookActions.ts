import {createCommand} from 'lexical';

export type NotebookAction = 'style' | 'present';

export const NOTEBOOK_ACTION_COMMAND = createCommand<NotebookAction>('NOTEBOOK_ACTION_COMMAND');

export function isNotebookAction(value: unknown): value is NotebookAction {
  return value === 'style' || value === 'present';
}

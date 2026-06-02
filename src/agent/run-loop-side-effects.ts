import { clearBackups } from '../utils/fileHistory.js';

export async function cleanBackups(): Promise<void> {
  await clearBackups();
}

import { existsSync, readFileSync } from 'node:fs';
import { micaConfig } from '@packages/mica-config/index.js';
import { writeTextFileAtomic } from '@packages/mica-config/atomicWrite.js';
import type { ConfigWebFilePayload } from '../shared/types.js';
import { assertValidConfig, validateConfigText } from '../../../../buildin-plugins/validate-config.mjs';

export function readConfigWebFile(): ConfigWebFilePayload {
  if (!existsSync(micaConfig.path)) micaConfig.read();
  return {
    path: micaConfig.path,
    content: readFileSync(micaConfig.path, 'utf-8'),
  };
}

export function writeConfigWebFile(content: string): ConfigWebFilePayload {
  const validation = validateConfigText(content, micaConfig.path);
  assertValidConfig(validation, micaConfig.path);
  writeTextFileAtomic(
    micaConfig.path,
    validation.changed ? `${JSON.stringify(validation.config, null, 2)}\n` : normalizeTrailingNewline(content),
  );
  return readConfigWebFile();
}

function normalizeTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}

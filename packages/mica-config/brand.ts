import { homedir } from 'node:os';
import { resolve } from 'node:path';

// Build-time runtime branding. These identifiers are injected by
// scripts/build.mjs (from mica.build.env) via `bun build --define`. When a
// value is not defined the upstream defaults below are used, so source runs
// (`bun run dev`, vitest) and unmodified builds behave exactly as before.
//
// NOTE: the build constants must only appear inside `typeof` guards. Reading a
// missing `__MICA_*__` identifier directly would throw a ReferenceError when
// running from source (where no `--define` is applied); the `typeof` guard is
// safe in both source and compiled runs.
declare const __MICA_RUNTIME_NAME__: string | undefined;
declare const __MICA_VERSION_LABEL__: string | undefined;
declare const __MICA_APP_NAME__: string | undefined;
declare const __MICA_CONFIG_DIR_NAME__: string | undefined;

const rawRuntimeName = typeof __MICA_RUNTIME_NAME__ === 'string' ? __MICA_RUNTIME_NAME__ : undefined;
const rawVersionLabel = typeof __MICA_VERSION_LABEL__ === 'string' ? __MICA_VERSION_LABEL__ : undefined;
const rawAppName = typeof __MICA_APP_NAME__ === 'string' ? __MICA_APP_NAME__ : undefined;
const rawConfigDirName = typeof __MICA_CONFIG_DIR_NAME__ === 'string' ? __MICA_CONFIG_DIR_NAME__ : undefined;

function pick(value: string | undefined, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

/** Externally visible runtime/command name (e.g. `mica`). */
export const RUNTIME_NAME = pick(rawRuntimeName, 'mica');
/** Machine-friendly version label shown by `--version` (e.g. `mica-code`). */
export const VERSION_LABEL = pick(rawVersionLabel, 'mica-code');
/** Human-readable product name used in UI/plugin text (e.g. `Mica Code`). */
export const APP_NAME = pick(rawAppName, 'Mica Code');
/** Default config directory name under the user home (e.g. `.mica`). */
export const CONFIG_DIR_NAME = pick(rawConfigDirName, '.mica');

/** Resolve the MICA_HOME directory, honoring the env override, else a branded directory. */
export function resolveMicaHome(): string {
  return process.env.MICA_HOME ? resolve(process.env.MICA_HOME) : resolve(homedir(), CONFIG_DIR_NAME);
}

/** Resolve a path inside MICA_HOME. */
export function resolveMicaHomePath(...parts: string[]): string {
  return resolve(resolveMicaHome(), ...parts);
}

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

/**
 * Resolve the diagnostic log directory.
 *
 * 放用户目录而不是系统 temp：temp 在 macOS 登录时被系统清空，重启之后就只能看当次运行，
 * 「昨天那次卡顿慢在哪」这类问题永远查不了。`MICA_LOG_DIR` 覆盖目录（测试、隔离实例用）。
 */
export function resolveLogDir(): string {
  const override = process.env.MICA_LOG_DIR;
  if (override) return resolve(override);
  if (process.platform === 'darwin') return resolve(homedir(), 'Library', 'Logs', RUNTIME_NAME);
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? resolve(homedir(), 'AppData', 'Local');
    return resolve(base, RUNTIME_NAME, 'logs');
  }
  const base = process.env.XDG_STATE_HOME ?? resolve(homedir(), '.local', 'state');
  return resolve(base, RUNTIME_NAME, 'logs');
}

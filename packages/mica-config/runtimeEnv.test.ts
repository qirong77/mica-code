import { describe, expect, it } from 'vitest';
import { readRuntimeEnvConfig } from './runtimeEnv.js';

describe('readRuntimeEnvConfig', () => {
  it('uses defaults when env vars are missing', () => {
    const config = readRuntimeEnvConfig({});

    expect(config.ui.runShellVerboseLogThresholdMs).toBe(2000);
    expect(config.ui.thinkingUpdateIntervalMs).toBe(30);
    expect(config.ui.scheduleStateThrottleMs).toBe(16);
    expect(config.ui.messageCollapseMaxLines).toBe(100);
  });

  it('reads numeric environment overrides', () => {
    const config = readRuntimeEnvConfig({
      MICA_RUN_SHELL_VERBOSE_LOG_THRESHOLD_MS: '5000',
      MICA_UI_THINKING_UPDATE_INTERVAL_MS: '120',
      MICA_UI_ASSISTANT_DISPLAY_MAX_CHARS: '100000',
      MICA_UI_MESSAGE_COLLAPSE_MAX_LINES: '250',
    });

    expect(config.ui.runShellVerboseLogThresholdMs).toBe(5000);
    expect(config.ui.thinkingUpdateIntervalMs).toBe(120);
    expect(config.ui.assistantDisplayMaxChars).toBe(100000);
    expect(config.ui.messageCollapseMaxLines).toBe(250);
  });

  it('falls back for invalid values and clamps out-of-range values', () => {
    const config = readRuntimeEnvConfig({
      MICA_RUN_SHELL_VERBOSE_LOG_THRESHOLD_MS: 'nope',
      MICA_UI_THINKING_UPDATE_INTERVAL_MS: '1',
      MICA_UI_ASSISTANT_DISPLAY_MAX_CHARS: '999999999',
      MICA_UI_MESSAGE_COLLAPSE_MAX_LINES: '0',
    });

    expect(config.ui.runShellVerboseLogThresholdMs).toBe(2000);
    expect(config.ui.thinkingUpdateIntervalMs).toBe(16);
    expect(config.ui.assistantDisplayMaxChars).toBe(1_000_000);
    expect(config.ui.messageCollapseMaxLines).toBe(1);
  });
});

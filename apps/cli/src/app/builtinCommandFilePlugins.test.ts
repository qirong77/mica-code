import { describe, expect, it, vi } from 'vitest';
import type { MicaPlugin, PluginContext } from '@packages/mica-plugin/index.js';
import { commandHostToken } from '@packages/mica-builtin-commands/commandHost.js';
import {
  setupCommandCd,
  setupCommandClear,
  setupCommandCompact,
  setupCommandBtw,
  setupCommandExit,
  setupCommandFork,
  setupCommandNew,
  setupCommandRename,
  setupCommandResume,
  setupCommandRewind,
} from '@packages/mica-builtin-commands/index.js';
import { useBuiltinPlugins } from './builtinPlugins.js';

const FILE_COMMANDS = [
  ['cd', setupCommandCd, undefined],
  ['clear', setupCommandClear, undefined],
  ['compact', setupCommandCompact, undefined],
  ['btw', setupCommandBtw, true],
  ['exit', setupCommandExit, true],
  ['fork', setupCommandFork, true],
  ['new', setupCommandNew, true],
  ['rename', setupCommandRename, true],
  ['resume', setupCommandResume, undefined],
  ['rewind', setupCommandRewind, undefined],
] as const;

describe('built-in command file plugins', () => {
  it.each(FILE_COMMANDS)('registers /%s through CommandHostService', (name, setup, allowDuringTurn) => {
    const registerCommand = vi.fn();
    const host = {
      agent: {},
      sessionController: {},
      services: {},
      registerCommand,
    };
    const ctx = {
      services: {
        get: vi.fn((token) => {
          expect(token).toBe(commandHostToken);
          return host;
        }),
      },
    };

    setup(ctx as unknown as PluginContext);

    expect(registerCommand).toHaveBeenCalledOnce();
    expect(registerCommand).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ name }),
      ...(allowDuringTurn === undefined ? [] : [{ allowDuringTurn }]),
    );
  });

  it('registers every file command as a required built-in plugin', () => {
    const plugins: MicaPlugin[] = [];
    const app = {
      use(plugin: MicaPlugin) {
        plugins.push(plugin);
        return this;
      },
    };

    useBuiltinPlugins(app, {} as never, {} as never);

    for (const [name] of FILE_COMMANDS) {
      expect(plugins).toContainEqual(
        expect.objectContaining({
          id: `builtin.command.${name}`,
          dependencies: ['builtin.commands'],
          required: true,
        }),
      );
    }
  });
});

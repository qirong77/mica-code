import { describe, expect, it, vi } from 'vitest';
import type { MicaPlugin } from '@packages/mica-plugin/index.js';
import { commandHostToken } from '@packages/mica-builtin-commands/commandHost.js';
import setupCommandCd from '../../../../plugins/builtin/command-cd.mjs';
import setupCommandClear from '../../../../plugins/builtin/command-clear.mjs';
import setupCommandCompact from '../../../../plugins/builtin/command-compact.mjs';
import setupCommandExit from '../../../../plugins/builtin/command-exit.mjs';
import setupCommandFork from '../../../../plugins/builtin/command-fork.mjs';
import setupCommandNew from '../../../../plugins/builtin/command-new.mjs';
import setupCommandRename from '../../../../plugins/builtin/command-rename.mjs';
import setupCommandResume from '../../../../plugins/builtin/command-resume.mjs';
import setupCommandRewind from '../../../../plugins/builtin/command-rewind.mjs';
import { useBuiltinPlugins } from './builtinPlugins.js';

const FILE_COMMANDS = [
  ['cd', setupCommandCd, undefined],
  ['clear', setupCommandClear, undefined],
  ['compact', setupCommandCompact, undefined],
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

    setup(ctx);

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

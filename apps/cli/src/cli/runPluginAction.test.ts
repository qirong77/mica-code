import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({ warmUp: vi.fn(), disposed: vi.fn() }));
vi.mock('@packages/mica-official-plugins/index.js', async () => {
  const { parsePluginManifest } = await import('@packages/mica-plugin/PluginManifest.js');
  const { readFileSync } = await import('node:fs');
  const { default: reviewSetup } = await import('../../../../plugins/harness-review/index.js');
  const { default: videoSetup } = await import('../../../../plugins/video/index.js');
  const manifest = (id: string) => {
    const parsed = parsePluginManifest(
      JSON.parse(readFileSync(new URL(`../../../../plugins/${id}/plugin.json`, import.meta.url), 'utf8')),
    );
    if (!parsed.ok) throw new Error('Invalid fixture manifest');
    return parsed.manifest;
  };
  return {
    officialPlugins: [
      { id: 'harness-review', setup: reviewSetup, manifest: manifest('harness-review') },
      { id: 'video', setup: videoSetup, manifest: manifest('video') },
      {
        id: 'broken',
        manifest: { actions: [{ key: 'run' }] },
        setup(ctx: any) {
          ctx.onDispose(probe.disposed);
          throw new Error('setup detail');
        },
      },
    ],
  };
});
vi.mock('../../../../plugins/video/VideoFramesTool.js', () => ({
  warmUpFfmpeg: probe.warmUp,
  VideoFramesTool: class {},
}));
vi.mock('../../../../plugins/video/frames.js', () => ({
  cacheStats: async () => ({ bytes: 0, files: 0 }),
  defaultCacheRoot: () => '/unused-video-cache',
}));

import { runPluginAction } from './runPluginAction.js';

const homes: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home() {
  const root = mkdtempSync(join(tmpdir(), 'mica-action-host-'));
  homes.push(root);
  vi.stubEnv('MICA_HOME', root);
  vi.stubEnv('MICA_PLUGIN_LOG', '0');
  return root;
}

describe('one-shot plugin action host', () => {
  it('opens review for the supplied workspace without starting recording or rebuilding', async () => {
    const root = home();
    const cwd = join(root, 'workspace with spaces');
    const result = await runPluginAction({ pluginId: 'harness-review', action: 'open-review', cwd });
    expect(result).toMatchObject({ ok: true, newSession: { cwd, send: false } });
    expect(existsSync(join(root, 'plugin-data', 'harness-review', 'state.json'))).toBe(false);
    expect(existsSync(join(root, 'plugin-health', 'harness-review.json'))).toBe(false);
  });

  it('does not invent a workspace when no context was provided', async () => {
    home();
    const result = await runPluginAction({ pluginId: 'harness-review', action: 'open-review' });
    expect(result.ok).toBe(true);
    expect(result.newSession).toBeUndefined();
    expect(result.message).toBeTruthy();
  });

  it('runs the video action without tools or prompt and probes only on click', async () => {
    home();
    probe.warmUp.mockResolvedValue({ version: 'ffmpeg test' });
    const result = await runPluginAction({
      pluginId: 'video',
      action: 'check',
      values: { ffmpegPath: '/test/ffmpeg' },
    });
    expect(result).toEqual({ ok: true, message: 'ffmpeg 可用：ffmpeg test' });
    expect(probe.warmUp).toHaveBeenCalledExactlyOnceWith('/test/ffmpeg');
  });

  it('returns the setup cause and releases partial registrations', async () => {
    home();
    const result = await runPluginAction({ pluginId: 'broken', action: 'run' });
    expect(result).toMatchObject({ ok: false, code: 'action_not_registered' });
    expect(result.error).toContain('setup detail');
    expect(probe.disposed).toHaveBeenCalledTimes(1);
  });

  it('rejects relative workspace paths before setup', async () => {
    home();
    expect(await runPluginAction({ pluginId: 'video', action: 'check', cwd: 'relative' })).toMatchObject({
      ok: false,
      code: 'invalid_cwd',
    });
    expect(probe.warmUp).not.toHaveBeenCalled();
  });
});

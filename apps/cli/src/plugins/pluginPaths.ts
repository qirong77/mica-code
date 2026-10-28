import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';

/**
 * 插件宿主读设置、写健康状态与日志时用的路径。
 *
 * 常驻会话（`HeadlessPluginHost`）与一次性命令（`runPluginCommand`）共用同一份，
 * 否则同一个插件在两个进程里会读到不同的 `plugin-settings`。
 */
export function createPluginPaths() {
  const config = resolveMicaHome();
  return {
    home: homedir(),
    config,
    plugins: join(config, 'plugins'),
  };
}

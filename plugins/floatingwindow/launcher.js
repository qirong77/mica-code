import { persistableAddress } from './address.js';

const MAX_WRITE_ATTEMPTS = 8;
export const MAX_RECENT_SITES = 20;

function recentSites(value) {
  if (!Array.isArray(value)) return [];
  const sites = [];
  for (const item of value) {
    const url = persistableAddress(item);
    if (url && !sites.includes(url)) sites.push(url);
    if (sites.length === MAX_RECENT_SITES) break;
  }
  return sites;
}

// This handler never opens the network or controls a window.
export default function createLauncher(ctx) {
  let disposed = false;
  let queue = Promise.resolve();
  const active = () => { if (disposed) throw new Error('Floating Window 已停用'); };
  async function remember(input) {
    const url = persistableAddress(input.url);
    if (!url) return { ok: true, saved: false };
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      active();
      const snapshot = await ctx.readData();
      active();
      const previous = snapshot.value && typeof snapshot.value === 'object' && !Array.isArray(snapshot.value) ? snapshot.value : {};
      const urls = [url, ...recentSites(previous.recentUrls).filter((item) => item !== url)].slice(0, MAX_RECENT_SITES);
      const result = await ctx.writeData({ ...previous, recentUrls: urls }, { expectedVersion: snapshot.version });
      if (result?.conflict === true) continue;
      if (result?.ok !== true) throw new Error(result?.error || '保存最近地址失败');
      return { ok: true, saved: true, urls };
    }
    throw new Error('最近地址正在被其他窗口更新，请重试');
  }
  return {
    async request(action, input = {}) {
      active();
      if (action === 'recent') {
        const snapshot = await ctx.readData();
        active();
        return { urls: recentSites(snapshot.value?.recentUrls) };
      }
      if (action === 'remember') {
        if (typeof input?.url !== 'string') throw new TypeError('remember.url 必须是字符串');
        const operation = queue.then(() => remember(input));
        queue = operation.catch(() => {});
        return operation;
      }
      throw new Error(`未知 Floating Window 操作：${action}`);
    },
    dispose() { disposed = true; },
  };
}

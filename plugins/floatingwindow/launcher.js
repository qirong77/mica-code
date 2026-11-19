import { persistableAddress } from './address.js';

const MAX_WRITE_ATTEMPTS = 8;
export const MAX_RECENT_SITES = 20;
export const MAX_FAVORITE_SITES = 20;

function siteOrigins(value, limit) {
  if (!Array.isArray(value)) return [];
  const sites = [];
  for (const item of value) {
    const url = persistableAddress(item);
    if (url && !sites.includes(url)) sites.push(url);
    if (sites.length === limit) break;
  }
  return sites;
}

function recentSites(value) { return siteOrigins(value, MAX_RECENT_SITES); }
function favoriteSites(value) { return siteOrigins(value, MAX_FAVORITE_SITES); }

function persistableFavicon(value) {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\s\u0000-\u001f\u007f\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return `${url.origin}${url.pathname || '/'}`;
  } catch { return null; }
}

function faviconMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [site, favicon] of Object.entries(value)) {
    const origin = persistableAddress(site);
    const safeFavicon = persistableFavicon(favicon);
    if (origin && safeFavicon) result[origin] = safeFavicon;
  }
  return result;
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
      const favicons = faviconMap(previous.favicons);
      const favicon = persistableFavicon(input.faviconUrl);
      if (favicon) favicons[url] = favicon;
      const result = await ctx.writeData({ ...previous, recentUrls: urls, favicons }, { expectedVersion: snapshot.version });
      if (result?.conflict === true) continue;
      if (result?.ok !== true) throw new Error(result?.error || '保存最近地址失败');
      return { ok: true, saved: true, urls, favicons };
    }
    throw new Error('最近地址正在被其他窗口更新，请重试');
  }
  async function setFavorite(input) {
    const url = persistableAddress(input.url);
    if (!url) return { ok: true, saved: false, favorite: false };
    const favorite = input.favorite === true;
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      active();
      const snapshot = await ctx.readData();
      active();
      const previous = snapshot.value && typeof snapshot.value === 'object' && !Array.isArray(snapshot.value) ? snapshot.value : {};
      const previousFavorites = favoriteSites(previous.favoriteUrls);
      const favorites = favorite
        ? [url, ...previousFavorites.filter((item) => item !== url)].slice(0, MAX_FAVORITE_SITES)
        : previousFavorites.filter((item) => item !== url);
      const result = await ctx.writeData({ ...previous, favoriteUrls: favorites }, { expectedVersion: snapshot.version });
      if (result?.conflict === true) continue;
      if (result?.ok !== true) throw new Error(result?.error || '保存收藏失败');
      return { ok: true, saved: true, favorite, favorites };
    }
    throw new Error('收藏正在被其他窗口更新，请重试');
  }
  return {
    async request(action, input = {}) {
      active();
      if (action === 'recent') {
        const snapshot = await ctx.readData();
        active();
        return {
          urls: recentSites(snapshot.value?.recentUrls),
          favorites: favoriteSites(snapshot.value?.favoriteUrls),
          favicons: faviconMap(snapshot.value?.favicons),
        };
      }
      if (action === 'remember') {
        if (typeof input?.url !== 'string') throw new TypeError('remember.url 必须是字符串');
        const operation = queue.then(() => remember(input));
        queue = operation.catch(() => {});
        return operation;
      }
      if (action === 'favorite') {
        if (typeof input?.url !== 'string') throw new TypeError('favorite.url 必须是字符串');
        if (typeof input?.favorite !== 'boolean') throw new TypeError('favorite.favorite 必须是布尔值');
        const operation = queue.then(() => setFavorite(input));
        queue = operation.catch(() => {});
        return operation;
      }
      throw new Error(`未知 Floating Window 操作：${action}`);
    },
    dispose() { disposed = true; },
  };
}

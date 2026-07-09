import { generatedStaticAssets } from './generatedStaticAssets.js';

const IMMUTABLE_ASSET_RE = /^\/assets\//;

export function serveGeneratedStaticAsset(pathname: string): Response | null {
  const assetPath = normalizeAssetPath(pathname);
  const asset = generatedStaticAssets[assetPath] ?? (IMMUTABLE_ASSET_RE.test(assetPath) ? undefined : generatedStaticAssets['/index.html']);
  if (!asset) return null;

  const bytes = Uint8Array.from(atob(asset.bodyBase64), (char) => char.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      'content-type': asset.contentType,
      'cache-control': IMMUTABLE_ASSET_RE.test(assetPath) ? 'public, max-age=31536000, immutable' : 'no-cache',
    },
  });
}

function normalizeAssetPath(pathname: string): string {
  if (pathname === '/' || pathname === '') return '/index.html';
  const decoded = decodeURIComponent(pathname);
  if (decoded.includes('..')) return '/index.html';
  return decoded;
}

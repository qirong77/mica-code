import { generatedStaticAssets } from './generatedStaticAssets.js';

const IMMUTABLE_ASSET_RE = /^\/(?:editor\/)?assets\//;

export function serveGeneratedStaticAsset(pathname: string): Response | null {
  const assetPath = normalizeAssetPath(pathname);
  if (assetPath === null) return null;
  const editorAsset = assetPath.startsWith('/editor/');
  const asset = generatedStaticAssets[assetPath] ?? (IMMUTABLE_ASSET_RE.test(assetPath) || editorAsset ? undefined : generatedStaticAssets['/index.html']);
  if (!asset) return null;

  const bytes = Uint8Array.from(atob(asset.bodyBase64), (char) => char.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      'content-type': asset.contentType,
      'cache-control': IMMUTABLE_ASSET_RE.test(assetPath) ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...(editorAsset ? {'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff'} : {}),
    },
  });
}

function normalizeAssetPath(pathname: string): string | null {
  if (pathname === '/' || pathname === '') return '/index.html';
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.split('/').some(part => part === '..' || part === '.') || /[\\\x00-\x1f]/.test(decoded)) return null;
  return decoded;
}

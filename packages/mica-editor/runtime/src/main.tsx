// Both modes share one Lexical/CDN graph; their data contracts stay separate.
if (new URLSearchParams(location.search).get('mode') === 'markdown') {
  await import('./markdown/index');
} else {
  await import('./playground/index');
}
export {};

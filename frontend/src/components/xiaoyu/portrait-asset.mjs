// A release must not reuse a cached bitmap after its file was replaced in place.
// The build already injects this version from the root version.json.
export function portraitAssetUrl(src, version = typeof __PRODUCT_VERSION__ === 'string' ? __PRODUCT_VERSION__ : '') {
  if (!version || !src.startsWith('/assets/portraits/')) return src;
  const url = new URL(src, 'http://localhost');
  url.searchParams.set('v', version);
  return url.pathname + url.search + url.hash;
}

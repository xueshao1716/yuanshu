// 账号档案的跨源交接（2026-10-18）。
//
// 为什么需要：档案存在 localStorage，而 localStorage 按源隔离。切到另一台元枢
// （或同一台的另一个地址，如局域网 IP）后，新源的档案列表是空的——用户看到的就是
// 「重新登了一下，啥都没有了」。
//
// 交接只带**标签 + 地址**，绝不带令牌：令牌进 URL 会留在地址栏、浏览器历史、
// 甚至被截图/分享，等于泄漏。到了新地址，令牌得在那台重新输入一次（由该源自己记住）。

const MAX = 12;
const b64 = (s) => (typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64'));
const unb64 = (s) => (typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary'));
const enc = (s) => encodeURIComponent(s);
const dec = (s) => decodeURIComponent(s);

export function encodeProfileHandoff(list = []) {
  const rows = (Array.isArray(list) ? list : [])
    .filter((p) => p && typeof p.apiBase === 'string')
    .slice(0, MAX)
    .map((p) => ({ label: String(p.label || '').slice(0, 40), apiBase: String(p.apiBase).slice(0, 200) }));
  if (!rows.length) return '';
  return b64(enc(JSON.stringify(rows)));
}

export function decodeProfileHandoff(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return [];
  try {
    const rows = JSON.parse(dec(unb64(raw)));
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((r) => r && typeof r.apiBase === 'string')
      .slice(0, MAX)
      .map((r) => ({ label: String(r.label || '').slice(0, 40), apiBase: String(r.apiBase).slice(0, 200) }));
  } catch { return []; }
}

/** 合并：按 apiBase 去重，保留本地的令牌，绝不把交接里的空令牌写进本地档案。 */
export function mergeProfileHandoff(local = [], incoming = []) {
  const out = (Array.isArray(local) ? local : []).filter((p) => p && typeof p.apiBase === 'string');
  for (const p of Array.isArray(incoming) ? incoming : []) {
    const base = String(p?.apiBase || '');
    if (!base || out.some((x) => x.apiBase === base)) continue;
    out.push({ id: `${base}#`, label: p.label || '', apiBase: base, token: '', savedAt: Date.now() });
    if (out.length >= MAX) break;
  }
  return out;
}

/** 从地址栏 hash 里读交接并去掉它（避免留在历史里）。 */
export function consumeProfileHandoff({ location: loc, history: hist } = {}) {
  const hash = String(loc?.hash || '');
  const m = /[#&]ph=([A-Za-z0-9%]+)/.exec(hash);
  if (!m) return [];
  const rows = decodeProfileHandoff(decodeURIComponent(m[1]));
  try {
    const rest = hash.replace(m[0], '').replace(/^#?&?/, '');
    hist?.replaceState(null, '', String(loc.pathname || '/') + String(loc.search || '') + (rest ? '#' + rest : ''));
  } catch {}
  return rows;
}

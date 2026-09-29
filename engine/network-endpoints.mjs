import { loadNetworkConfig } from './system-panel.mjs';

function normalizeOrigin(value, { allowLoopback = true } = {}) {
  const raw = String(value || '').trim();
  if (!raw || raw === '*') return '';
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return '';
    if (!allowLoopback && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return '';
    return url.origin;
  } catch { return ''; }
}

export function resolveShareOrigin({ host = '', agentDir = '' } = {}) {
  const explicit = String(host || '').trim();
  if (explicit) return normalizeOrigin(explicit, { allowLoopback: false });
  if (!agentDir) return '';
  const configured = loadNetworkConfig(agentDir)?.domains || [];
  const share = configured.find((entry) => /外网分享|分享|share/i.test(String(entry?.desc || '')) && entry?.domain);
  const first = share || configured.find((entry) => entry?.domain);
  return normalizeOrigin(first?.domain || '', { allowLoopback: false });
}

export function voiceAllowedOrigins({ agentDir = '', configured = '', port = 8787 } = {}) {
  const values = [];
  const domains = loadNetworkConfig(agentDir)?.domains || [];
  for (const entry of domains) {
    const origin = normalizeOrigin(entry?.domain, { allowLoopback: false });
    if (origin) values.push(origin);
  }
  for (const item of String(configured || '').split(',')) {
    const origin = normalizeOrigin(item, { allowLoopback: false });
    if (origin) values.push(origin);
  }
  const safePort = Number.isInteger(Number(port)) && Number(port) > 0 ? Number(port) : 8787;
  values.push(`http://127.0.0.1:${safePort}`, `http://localhost:${safePort}`);
  return [...new Set(values)];
}

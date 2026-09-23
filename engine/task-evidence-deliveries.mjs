import path from 'node:path';

// Recognize a narrow, literal download record; never execute or fetch anything.
function download(command) {
  if (typeof command !== 'string' || /[\r\n$`|;<>]/.test(command)) return null;
  const tokens = [], pattern = /\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"']+))/y;
  let offset = 0;
  while (offset < command.length) {
    if (!command.slice(offset).trim()) break;
    pattern.lastIndex = offset;
    const m = pattern.exec(command);
    if (!m) return null;
    if (m[3] && /[&()]/.test(m[3])) return null;
    tokens.push(m[1] ?? m[2] ?? m[3]); offset = pattern.lastIndex;
  }
  if (!/^curl(?:\.exe)?$/i.test(tokens.shift() || '')) return null;
  let source, target;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (/^-[sSLf]+$/.test(token) || ['--silent', '--show-error', '--location', '--fail'].includes(token)) continue;
    if (['-o', '--output'].includes(token)) { if (target) return null; target = tokens[++i]; }
    else if (token === '--url') { if (source) return null; source = tokens[++i]; }
    else if (/^https?:\/\//i.test(token) && !source) source = token;
    else return null;
  }
  if (!source || !target || !/^https?:\/\//i.test(source) || target.startsWith('-') || /[&*?{}[\]!%]/.test(target)) return null;
  return { source, target };
}

function localReference(wsRoot, value) {
  let relative = String(value);
  if (relative.startsWith('/api/ws/file?')) relative = new URL(relative, 'http://local').searchParams.get('path') || '';
  if (/^[a-z]+:\/\//i.test(relative)) return null;
  if (path.isAbsolute(relative)) relative = path.relative(wsRoot, relative);
  return relative.replaceAll('\\', '/');
}

export function resolveDeliveryReferences(wsRoot, references, events) {
  const locals = new Set(references.map(r => localReference(wsRoot, r)).filter(Boolean));
  const calls = new Map(), ends = new Map(), pairs = new Map();
  for (const e of events) {
    const d = e.data || {};
    if (['tool', 'tool_start', 'tool_started'].includes(e.type) && d.id) {
      calls.set(d.id, calls.has(d.id) ? null : d);
    }
    if (['tool_end', 'tool_finished'].includes(e.type) && d.id) {
      ends.set(d.id, ends.has(d.id) ? null : { data: d, call: calls.get(d.id) });
    }
  }
  for (const end of ends.values()) {
    const d = end?.data, call = end?.call;
    if (!call || call.name !== 'bash' || d.name !== 'bash' || d.isError !== false || d.uncertain || !d.output) continue;
    let args = call.args;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { continue; } }
    const pair = download(args?.command);
    if (!pair) continue;
    const local = localReference(wsRoot, pair.target);
    if (locals.has(local)) pairs.set(pair.source, pairs.has(pair.source) && pairs.get(pair.source) !== local ? null : local);
  }
  return [...new Set(references.map(r => pairs.get(r) || localReference(wsRoot, r) || r))];
}

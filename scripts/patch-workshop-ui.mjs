// Mechanical, idempotent adapter patch for the pinned M3E export. Fail on upstream drift.
import fs from 'node:fs';
const base = new URL('../public/workshop-ui/', import.meta.url);
const bundle = new URL('_next/static/chunks/042i1k4w8mtp9.js', base);
let code = fs.readFileSync(bundle, 'utf8');
for (const key of ['m3e:doc', 'm3e:doc:before', 'm3e:doc:editor']) {
  const before = JSON.stringify(key), after = `${before}+(window.yuanshuCanvasScope||"")`;
  if (code.includes(after)) continue;
  if (code.split(before).length !== 2) throw new Error(`Upstream changed: ${key}`);
  code = code.replace(before, after);
}
const ready = 'window.yuanshuCanvasReady=true;window.dispatchEvent(new Event("yuanshu-canvas-ready"))';
if (!code.includes(ready)) {
  const anchor = '(0,s.useEffect)(()=>{if(tx.current&&"editable"===t)try{localStorage.setItem(hl,';
  if (code.split(anchor).length !== 2) throw new Error('Upstream changed: editor persistence effect');
  code = code.replace(anchor, `(0,s.useEffect)(()=>{if(!window.yuanshuCanvasReady){${ready}}},[]),${anchor}`);
}
fs.writeFileSync(bundle, code);
const index = new URL('index.html', base);
let html = fs.readFileSync(index, 'utf8');
if (!html.includes('yuanshu-bootstrap.js')) html = html.replace('<head>', '<head><script src="./yuanshu-bootstrap.js?v=14"></script>');
if (!html.includes('yuanshu-project.js')) html = html.replace('</body>', '<script src="./yuanshu-project.js?v=14"></script></body>');
html = html.replaceAll('yuanshu-shell.css?v=13', 'yuanshu-shell.css?v=14').replaceAll('yuanshu-shell.js?v=13', 'yuanshu-shell.js?v=14');
html = html.replace(/(yuanshu-(?:bootstrap|project|shell)\.(?:js|css)\?v=)\d+/g, '$116');
fs.writeFileSync(index, html);
console.log('M3E scope, bootstrap and project adapter applied');

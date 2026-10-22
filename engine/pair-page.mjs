// engine/pair-page.mjs —— 扫码配对页（2026-10-22）
//
// 全站 CSP 是 script-src 'self'，内联脚本跑不起来（音乐登录页因此做成零 JS）。
// 这里需要轮询状态，所以脚本走同源外部文件 /pair.js，页面只放 data-code。
export function renderPairPage(code) {
  const safe = String(code || '').replace(/[^A-Z0-9]/gi, '').slice(0, 12);
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>元枢 · 扫码登录</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100dvh; display:flex; align-items:center; justify-content:center;
         font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; background:#f6f7f9; color:#111; }
  @media (prefers-color-scheme: dark) { body { background:#0e1116; color:#e8eaed; } .card { background:#171b22; border-color:#2a2f38; } }
  .card { width:min(92vw,380px); padding:28px 24px; border-radius:16px; background:#fff; border:1px solid #e6e8eb;
          box-shadow:0 8px 30px rgba(0,0,0,.06); text-align:center; }
  .code { font:600 26px/1.2 ui-monospace,Consolas,monospace; letter-spacing:.18em; margin:10px 0 4px; }
  .hint { color:#6b7280; font-size:13px; }
  .ok { color:#0a7d33; } .err { color:#b42318; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:#f59e0b; margin-right:6px; }
  button { margin-top:16px; padding:10px 18px; border-radius:10px; border:1px solid #d0d5dd; background:#fff; font:inherit; }
</style></head>
<body data-pair-code="${safe}"><div class="card">
  <div class="hint">元枢 · 手机登录</div>
  <div class="code" id="code">${safe}</div>
  <div class="hint" id="state"><span class="dot"></span>正在通知电脑…</div>
  <div class="hint" id="detail"></div>
  <button id="retry" hidden>重试</button>
</div>
<script src="/pair.js"></script>
</body></html>`;
}

// 同源外部脚本（CSP 'self' 允许）。逻辑：认领 → 轮询 → 取令牌 → 存本地 → 回首页
export const PAIR_JS = String.raw`
(function () {
  var code = String((document.body && document.body.dataset.pairCode) || '').trim();
  var stateEl = document.getElementById('state');
  var detailEl = document.getElementById('detail');
  var retry = document.getElementById('retry');
  var tokenKey = 'yuanshu_access_token';
  var stopped = false;

  function setState(text, cls) {
    stateEl.innerHTML = '<span class="dot"></span>' + text;
    stateEl.className = 'hint ' + (cls || '');
  }
  function deviceName() {
    var ua = navigator.userAgent || '';
    var m = ua.match(/\((?:Linux; )?(?:Android|iPhone|iPad)[^)]*\)/);
    if (m) return m[0].replace(/[()]/g, '').slice(0, 40);
    return '手机浏览器';
  }
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }); });
  }
  function poll() {
    if (stopped) return;
    fetch('/api/pair/status?code=' + encodeURIComponent(code)).then(function (r) { return r.json(); }).then(function (s) {
      if (stopped) return;
      if (s.status === 'approved') {
        return post('/api/pair/token', { code: code }).then(function (t) {
          if (t && t.ok && t.token) {
            try { localStorage.setItem(tokenKey, t.token); } catch (e) {}
            stopped = true;
            setState('登录成功，正在进入…', 'ok');
            setTimeout(function () { location.replace('/'); }, 400);
          } else {
            setState('取令牌失败：' + (t && t.reason ? t.reason : '未知'), 'err');
            retry.hidden = false;
          }
        });
      }
      if (s.status === 'claimed') { setState('已通知电脑，请在电脑上点「允许」', ''); }
      if (s.status === 'pending') { setState('正在通知电脑…', ''); }
      if (s.status === 'expired') {
        setState('二维码已过期，请在电脑上重新生成', 'err');
        stopped = true; retry.hidden = false;
        return;
      }
      setTimeout(poll, 1500);
    }).catch(function () { setTimeout(poll, 2500); });
  }

  if (!code) { setState('缺少配对码', 'err'); return; }
  post('/api/pair/claim', { code: code, deviceName: deviceName() }).then(function (r) {
    if (!r || !r.ok) {
      setState(r && r.reason === 'expired' ? '二维码已过期，请重新生成' : '认领失败：' + (r && r.reason ? r.reason : '未知'), 'err');
      retry.hidden = false;
      return;
    }
    detailEl.textContent = '本机：' + deviceName();
    setState('已通知电脑，请在电脑上点「允许」', '');
    poll();
  }).catch(function () { setState('网络不通：确认手机和电脑在同一局域网', 'err'); retry.hidden = false; });

  retry.addEventListener('click', function () { location.reload(); });
})();
`;

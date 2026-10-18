// 网易云登录页（服务端渲染，零 JS）
// 之前用内联脚本 + fetch 画二维码，被全站 CSP `script-src 'self'` 直接拦掉 →
// 页面上永远停在「正在获取二维码…」。改成把二维码 data URI 直接写进 HTML，
// 用 meta refresh 每 5 秒重取一次；服务端在快过期时自动换码。
export function renderMusicLoginPage(view = {}, { resetUrl = '/music-login?reset=1' } = {}) {
  const loggedIn = !!view.loggedIn;
  const state = Number(view.state) || 0;
  const img = typeof view.qrimg === 'string' && view.qrimg.startsWith('data:image') ? view.qrimg : '';
  const seconds = Math.max(0, Math.round((Number(view.expiresInMs) || 0) / 1000));
  const map = { 801: '等待扫码', 802: '已扫描，请在手机上确认', 800: '二维码已过期，正在换新码', 803: '登录成功' };
  const status = loggedIn ? '登录成功 ✓ 可以关闭本页，回对话里让她放歌' : (map[state] || view.message || '正在获取二维码…');
  const tone = loggedIn || state === 802 ? '#63d68a' : '#d8b45f';
  const body = loggedIn
    ? '<div class="done">已登录，无需再扫码。</div>'
    : img
      ? `<div class="qr"><img src="${img}" alt="网易云登录二维码"></div>`
      : '<div class="qr empty">二维码暂时取不到，稍等会自动重试</div>';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${loggedIn ? '' : '<meta http-equiv="refresh" content="5">'}
<title>登录网易云 · 元枢</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101114;color:#e7e7ea;
       font:14px/1.6 -apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif;color-scheme:dark}
  .card{width:min(440px,92vw);padding:28px 24px;border:1px solid #26272c;border-radius:16px;background:#17181c;
        box-shadow:0 10px 40px rgba(0,0,0,.45);text-align:center}
  h1{margin:0 0 6px;font-size:17px;font-weight:600}
  .sub{margin:0;color:#9a9ba2;font-size:12.5px}
  .qr{margin:18px auto 12px;width:240px;height:240px;border-radius:12px;background:#fff;padding:8px;box-sizing:border-box}
  .qr img{width:100%;height:100%;display:block;image-rendering:pixelated}
  .qr.empty{width:auto;height:auto;background:#15161a;border:1px dashed #33353b;color:#8b8c93;
            display:grid;place-items:center;padding:24px;font-size:12.5px}
  .state{margin-top:10px;font-size:13px;color:${tone}}
  .done{padding:28px 12px;font-size:14px;color:#63d68a}
  .hint{margin-top:14px;font-size:11.5px;color:#6f7178}
  a{color:#8b8c93}
</style></head>
<body><div class="card">
  <h1>用网易云音乐 App 扫码</h1>
  <p class="sub">扫完请在手机上点「确认登录」。二维码会自动更换，不用管过期。</p>
  ${body}
  <div class="state">${status}</div>
  ${loggedIn ? '' : `<div class="hint">剩余 ${seconds} 秒后自动换码 · <a href="${resetUrl}">换一张</a></div>`}
</div></body></html>`;
}

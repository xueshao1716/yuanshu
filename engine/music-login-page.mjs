// 网易云登录页（本机浏览器打开）：二维码自动换、状态实时更新。
export const MUSIC_LOGIN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录网易云 · 元枢</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101114;color:#e7e7ea;
       font:14px/1.6 -apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif}
  .card{width:min(420px,92vw);padding:28px 24px;border:1px solid #26272c;border-radius:16px;background:#17181c;
        box-shadow:0 10px 40px rgba(0,0,0,.45);text-align:center}
  h1{margin:0 0 6px;font-size:17px;font-weight:600}
  p{margin:0;color:#9a9ba2;font-size:12.5px}
  .qr{margin:18px auto 12px;width:240px;height:240px;border-radius:12px;background:#fff;padding:8px}
  .qr img{width:100%;height:100%;display:block;image-rendering:pixelated}
  .state{margin-top:10px;font-size:13px;min-height:20px}
  .ok{color:#63d68a}.wait{color:#d8b45f}
  .hint{margin-top:14px;font-size:11.5px;color:#6f7178}
  button{margin-top:14px;padding:7px 14px;border-radius:8px;border:1px solid #33353b;background:#22242a;color:#d7d8dd;cursor:pointer}
</style></head>
<body><div class="card">
  <h1>用网易云音乐 App 扫码</h1>
  <p>扫完请在手机上点「确认登录」。二维码会自动更换，不用管过期。</p>
  <div class="qr"><img id="qr" alt="二维码" /></div>
  <div id="state" class="state wait">正在获取二维码…</div>
  <div class="hint">登录成功后可以关闭本页，回对话里让她放歌。</div>
  <button id="again" type="button">换一张</button>
</div>
<script>
  const qr = document.getElementById('qr'), st = document.getElementById('state');
  let lastKey = '';
  async function tick() {
    try {
      const r = await fetch('/api/music/login', { cache: 'no-store' });
      const j = await r.json();
      if (j.qrimg && j.qrimg !== lastKey) { qr.src = j.qrimg; lastKey = j.qrimg; }
      if (j.loggedIn) { st.textContent = '登录成功 ✓ 可以关闭本页'; st.className = 'state ok'; return true; }
      const map = { 801: '等待扫码', 802: '已扫描，请在手机上确认', 800: '二维码已过期，正在换新码' };
      st.textContent = map[j.state] || j.message || '等待扫码';
      st.className = 'state ' + (j.state === 802 ? 'ok' : 'wait');
    } catch (e) { st.textContent = '连接不上本机服务'; st.className = 'state wait'; }
    return false;
  }
  async function loop() { if (await tick()) return; setTimeout(loop, 2000); }
  loop();
  document.getElementById('again').onclick = async () => { lastKey = ''; await tick(); };
</script></body></html>`;

// 启动兜底：主包在老浏览器里解析失败/加载失败时，#root 会一直是空的（整页黑/白）。
// 这里只用 ES5，过几秒还没渲染就把原因直接写在页面上。
(function () {
  var errors = [];
  window.addEventListener('error', function (e) {
    var t = e && e.target;
    if (t && t !== window && (t.src || t.href)) errors.push('资源加载失败：' + (t.src || t.href));
    else if (e && e.message) errors.push(e.message + (e.filename ? ' @ ' + e.filename.split('/').pop() + ':' + e.lineno : ''));
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    errors.push('未处理的异常：' + (r && r.message ? r.message : String(r)));
  });
  setTimeout(function () {
    var root = document.getElementById('root');
    if (!root || root.children.length > 0) return;
    var box = document.createElement('div');
    box.setAttribute('data-boot-fail', '');
    box.style.cssText = 'max-width:560px;margin:12vh auto;padding:24px 28px;font:14px/1.7 system-ui,sans-serif;' +
      'color:#1f2328;background:#fff;border:1px solid #d0d7de;border-radius:12px;';
    var html = '<h2 style="margin:0 0 8px;font-size:18px">元枢没有正常启动</h2>' +
      '<p style="margin:0 0 8px">通常是浏览器版本太旧。请用最新版 Chrome 或 Edge 打开，或者先把浏览器更新到最新版再刷新。</p>' +
      '<p style="margin:0;color:#57606a">浏览器：' + navigator.userAgent.replace(/</g, '&lt;') + '</p>';
    if (errors.length) {
      html += '<pre style="margin:12px 0 0;padding:10px;background:#f6f8fa;border-radius:8px;white-space:pre-wrap;font-size:12px">' +
        errors.slice(0, 5).join('\n').replace(/</g, '&lt;') + '</pre>';
    }
    box.innerHTML = html;
    document.body.style.background = '#f6f8fa';
    document.body.appendChild(box);
  }, 8000);
})();

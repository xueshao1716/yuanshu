// 元枢壳连接页：输入工作台地址 → 记住 → 整窗跳转。
// 无任何外部依赖；地址存本页 origin 的 localStorage（壳内置页，持久可靠）。
(function () {
  'use strict';
  var KEY = 'yuanshu.server';
  var input = document.getElementById('addr');
  var err = document.getElementById('err');
  var btn = document.getElementById('go');

  try { input.value = localStorage.getItem(KEY) || ''; } catch (e) { /* 存储不可用则不记住 */ }

  function normalize(raw) {
    var v = String(raw || '').trim().replace(/\/+$/, '');
    if (!v) return null;
    if (!/^https?:\/\//i.test(v)) {
      // 局域网/本机地址默认 http，其余默认 https
      v = (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?/i.test(v) ? 'http://' : 'https://') + v;
    }
    try { return new URL(v).origin === 'null' ? null : v; } catch (e) { return null; }
  }

  function connect() {
    var url = normalize(input.value);
    if (!url) { err.textContent = '地址无效。示例：https://your.domain 或 http://192.168.1.10:8787'; return; }
    err.textContent = '';
    try { localStorage.setItem(KEY, url); } catch (e) {}
    btn.disabled = true; btn.textContent = '正在跳转…';
    window.location.href = url + '/';
  }

  btn.addEventListener('click', connect);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') connect(); });
  input.addEventListener('input', function () { err.textContent = ''; });
})();

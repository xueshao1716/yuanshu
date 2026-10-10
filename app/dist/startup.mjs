const messages = {
  TASK_UNAVAILABLE: '无法读取元枢守护任务。请检查是否已安装，以及当前用户是否有访问权限。',
  TASK_DISABLED: '元枢守护任务已禁用。请在 Windows 任务计划程序中启用后重试。',
  TASK_START_DENIED: 'Windows 未允许启动守护任务。请检查该任务的运行账户与权限后重试。',
  HEALTH_TIMEOUT: '已请求启动，但服务尚未就绪。请检查服务目录的 watchdog.log；修复后可再次连接。',
  START_BUSY: '另一个启动请求正在处理，请稍后重试。',
  NAVIGATION_FAILED: '服务已就绪，但工作台未能打开。请重新连接。',
};

function isLocal(base) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(base);
}

export function createStartup({ invoke, render }) {
  let busy = false;
  return async (address, token) => {
    if (busy) return;
    busy = true;
    const base = (address || 'http://127.0.0.1:8787').trim().replace(/\/+$/, '');
    if (!token.trim()) {
      render({ phase: 'error', message: '请输入访问令牌。' });
      busy = false;
      return;
    }
    // 把 token 和 base 放在 hash 里传给目标页面（不会发到服务器）
    const hash = '#_t=' + encodeURIComponent(token.trim()) + '&_b=' + encodeURIComponent(base);
    const targetUrl = base + '/' + hash;

    if (isLocal(base)) {
      render({ phase: 'starting', message: '正在检查本机服务；未运行时请求守护任务启动。通常需要几秒，最多等待一分钟。' });
      try {
        await invoke('ensure_local_service');
        await invoke('navigate_to_url', { url: targetUrl });
        render({ phase: 'ready', message: '服务已就绪，正在进入工作台。' });
      } catch (error) {
        const code = String(error?.message || error);
        render({ phase: 'error', message: messages[code] || '启动检查未完成。请确认 Windows PowerShell 和元枢守护任务可用，然后重试。' });
        busy = false;
      }
    } else {
      render({ phase: 'starting', message: '正在连接远程工作台…' });
      try {
        await invoke('navigate_to_url', { url: targetUrl });
        render({ phase: 'ready', message: '正在进入工作台。' });
      } catch {
        render({ phase: 'error', message: '无法导航到指定地址，请检查地址格式是否正确（需包含 http:// 或 https://）。' });
        busy = false;
      }
    }
  };
}

if (typeof document !== 'undefined') {
  const form = document.querySelector('#connect-form');
  const addressInput = document.querySelector('#address');
  const tokenInput = document.querySelector('#token');
  const errorEl = document.querySelector('#error');
  const connectBtn = document.querySelector('#connect');

  const run = createStartup({
    invoke: (name, args) => window.__TAURI__.core.invoke(name, args),
    render({ phase, message }) {
      errorEl.textContent = phase === 'error' ? message : '';
      connectBtn.setAttribute('aria-busy', String(phase === 'starting'));
      connectBtn.disabled = phase === 'starting';
      connectBtn.textContent = phase === 'starting' ? '正在连接…' : '连接';
      if (phase === 'error') {
        connectBtn.disabled = false;
      }
    },
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    run(addressInput.value, tokenInput.value);
  });

  tokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); run(addressInput.value, tokenInput.value); }
  });
}

const messages = {
  TASK_UNAVAILABLE: '无法读取元枢守护任务。请检查是否已安装，以及当前用户是否有访问权限。',
  TASK_DISABLED: '元枢守护任务已禁用。请在 Windows 任务计划程序中启用后重试。',
  TASK_START_DENIED: 'Windows 未允许启动守护任务。请检查该任务的运行账户与权限后重试。',
  HEALTH_TIMEOUT: '已请求启动，但服务尚未就绪。请检查服务目录的 watchdog.log；修复后可再次连接。',
  START_BUSY: '另一个启动请求正在处理，请稍后重试。',
  NAVIGATION_FAILED: '服务已就绪，但工作台未能打开。请重新连接。',
};
export function createStartup({ invoke, render }) {
  let busy = false;
  return async () => {
    if (busy) return;
    busy = true;
    render({ phase: 'starting', message: '正在检查本机服务；未运行时请求守护任务启动。通常需要几秒，最多等待一分钟。' });
    try {
      await invoke('ensure_local_service');
      await invoke('enter_local_workspace');
      render({ phase: 'ready', message: '服务已就绪，正在进入工作台。' });
    } catch (error) {
      const code = String(error?.message || error);
      render({ phase: 'error', message: messages[code] || '启动检查未完成。请确认 Windows PowerShell 和元枢守护任务可用，然后重试。' });
    } finally { busy = false; }
  };
}

if (typeof document !== 'undefined') {
  const button = document.querySelector('#retry');
  const status = document.querySelector('#status');
  const run = createStartup({
    invoke: name => window.__TAURI__.core.invoke(name),
    render({ phase, message }) {
      button.setAttribute('aria-busy', String(phase === 'starting'));
      status.textContent = message;
      button.disabled = phase === 'starting';
      button.textContent = phase === 'starting' ? '正在连接…' : '重新连接';
    },
  });
  button.addEventListener('click', run);
  run();
}

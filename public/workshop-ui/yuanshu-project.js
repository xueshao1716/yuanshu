(() => {
  if (window.yuanshuCanvasReady) init();
  else window.addEventListener('yuanshu-canvas-ready', init, {once:true});
  function init() {
  if (!window.yuanshuCanvasScope) return;
  const params = new URLSearchParams(location.search), project = params.get('project');
  let parentId = params.get('version'), saved = '', originalDoc = '', ready = false, saving = false;
  const key = 'm3e:doc' + window.yuanshuCanvasScope;
  const read = () => localStorage.getItem(key) || '';
  const normalized = window.yuanshuCanvasComparable;
  async function api(path, body) {
    const token = localStorage.getItem('yuanshu_access_token') || localStorage.getItem('pi_web_token') || '';
    const response = await fetch('/api/workshop-ui/projects/' + project + path, {
      method: body ? 'POST' : 'GET', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(response.status === 401 ? '请返回元枢登录后再保存' : data.error || '保存失败');
    return data;
  }
  const status = document.createElement('span'); status.id = 'yuanshu-save-status'; status.setAttribute('role','status');
  const button = document.createElement('button'); button.textContent = '保存新版本'; button.disabled = true;
  button.id = 'yuanshu-save';
  const restoring = window.yuanshuCanvasNeedsRestore;
  if (restoring) document.documentElement.classList.add('yuanshu-restoring');
  function mount() {
    const bar = document.getElementById('yuanshu-bar');
    if (bar && !bar.contains(button)) bar.append(button, status);
    const back = document.getElementById('yuanshu-back');
    if (back && back.textContent !== '返回作品') back.textContent = '返回作品';
  }
  mount();
  new MutationObserver(mount).observe(document.documentElement, {childList:true,subtree:true});
  status.textContent = restoring ? '正在恢复服务器版本…' : '正在读取作品…';
  sessionStorage.setItem('yuanshu-ui-project', project);
  function dirty() { return ready && normalized(read()) !== saved; }
  window.addEventListener('beforeunload', event => { if (dirty() || saving) {event.preventDefault();event.returnValue='';} });
  api('').then(p => {
    const version = p.versions.find(v => v.id === parentId);
    if (!version) throw new Error('版本不存在，请返回作品重新打开');
    if (restoring) {
      localStorage.setItem(key, JSON.stringify(version.doc));
      location.reload(); return;
    }
    originalDoc = JSON.stringify(version.doc);
    saved = normalized(originalDoc); ready = true; button.disabled = false;
    status.textContent = '草稿在本机；请保存新版本';
  }).catch(error => {status.textContent = error.message;});
  button.onclick = async () => {
    if (!ready || saving) return;
    saving = true; button.disabled = true; status.textContent = '保存中…';
    try {
      const raw = read(); if (!raw) throw new Error('画布尚未就绪');
      const version = await api('/versions', {doc: JSON.parse(raw), parentId, label: '画布修改'});
      parentId = version.id; saved = normalized(JSON.stringify(version.doc));
      status.textContent = '已保存新版本；原版本保留';
      // The saved draft now belongs to the new version. Reopening an old version
      // must not silently show the contents that have already been saved as new.
      localStorage.setItem(`m3e:doc:${project}:${version.id}`, JSON.stringify(version.doc));
      localStorage.setItem(key, originalDoc);
      ready = false; saving = false;
      const next = new URL(location.href); next.searchParams.set('version', version.id);
      location.replace(next.href);
    } catch (error) {status.textContent = error.message || '保存失败，草稿仍在本机';}
    finally {saving = false; button.disabled = false;}
  };
  }
})();

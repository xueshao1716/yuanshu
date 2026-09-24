// Must run before the vendored editor: a draft and editor lock belong to one version.
(() => {
  const w = window, params = new URLSearchParams(w.location.search);
  const valid = value => /^[a-f0-9-]{36}$/.test(value || '');
  const project = params.get('project'), version = params.get('version');
  w.yuanshuCanvasScope = valid(project) && valid(version) ? `:${project}:${version}` : '';
  const read = key => { try { return w.localStorage.getItem(key) || ''; } catch { return ''; } };
  w.yuanshuCanvasNeedsRestore = !!w.yuanshuCanvasScope && !read('m3e:doc' + w.yuanshuCanvasScope);
  w.yuanshuWorkshopModel = read('yuanshu-ui-model');
  w.yuanshuCanvasComparable = text => {
    const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
    try { return JSON.stringify(sort({dynamicColor:false, ...JSON.parse(text)})); } catch { return text; }
  };
  const original = w.fetch.bind(w);
  w.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input.url, w.location.origin);
    if (url.origin === w.location.origin && url.pathname === '/api/workshop-ui/v1/chat/completions' && typeof options?.body === 'string') {
      const body = JSON.parse(options.body), headers = new Headers(options.headers);
      if (w.yuanshuWorkshopModel) body.model = w.yuanshuWorkshopModel;
      headers.set('Authorization', `Bearer ${read('yuanshu_access_token') || read('pi_web_token')}`);
      options = {...options, headers, body: JSON.stringify(body)};
    }
    return original(input, options);
  };
})();

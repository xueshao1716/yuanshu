const http = require('node:http');

function serviceHealthy(port = 8787, timeout = 2500) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const request = http.get({ hostname: '127.0.0.1', port, path: '/api/health', agent: false }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 8192) { finish(false); request.destroy(); }
      });
      response.on('error', () => finish(false));
      response.on('end', () => {
        try { finish(response.statusCode === 200 && JSON.parse(body).ok === true); }
        catch { finish(false); }
      });
    });
    const timer = setTimeout(() => { finish(false); request.destroy(); }, timeout);
    request.on('error', () => finish(false));
  });
}

function singleFlight(action) {
  let pending;
  return (...args) => {
    if (!pending) pending = Promise.resolve().then(() => action(...args)).finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { serviceHealthy, singleFlight };

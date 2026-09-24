import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Serve real components, but never proxy to the running application or providers.
export async function startReliabilityFixture() {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const frontend = fileURLToPath(new URL('../../../frontend/', import.meta.url))
  const require = createRequire(new URL('../../../frontend/package.json', import.meta.url))
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href)
  const entry = fileURLToPath(new URL('./reliability-ui.tsx', import.meta.url)).split(String.fromCharCode(92)).join('/')
  const previousCwd = process.cwd()
  process.chdir(frontend)
  const server = await createServer({
    root: frontend, configFile: frontend + 'vite.config.ts', logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false, open: false, fs: { allow: [root] } },
    plugins: [{ name: 'isolated-reliability-fixture',
      configResolved(config) { config.server.proxy = {}; config.server.hmr = false },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          const pathname = new URL(req.url, 'http://127.0.0.1').pathname
          if (pathname.startsWith('/api/') || pathname.startsWith('/static/')) {
            res.statusCode = 503; res.end('Fixture has no backend'); return
          }
          if (pathname.startsWith('/fixture/')) {
            if (pathname.endsWith('/hang')) return
            res.setHeader('content-type', 'text/html; charset=utf-8')
            res.end('<!doctype html><title>临时测试页</title><h1>本地测试内容</h1>'); return
          }
          if (pathname !== '/__reliability') return next()
          try {
            const html = await vite.transformIndexHtml(pathname, '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@fs/' + entry + '"></script></body></html>')
            res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html)
          } catch (error) { res.statusCode = 500; res.end(String(error)) }
        })
      },
    }],
  })
  process.chdir(previousCwd)
  await server.listen()
  return { server, origin: 'http://127.0.0.1:' + server.httpServer.address().port }
}

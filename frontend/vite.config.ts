import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import UnoCSS from 'unocss/vite'
import { readFileSync } from 'node:fs'

// 版本唯一来源是仓库根的 version.json（契约见 docs/NAMING.md）。
// 构建时注入成 __PRODUCT_VERSION__，前端在命名产物时同步就能拿到，不用等接口。
const PRODUCT_VERSION = (() => {
  try { return String(JSON.parse(readFileSync(new URL('../version.json', import.meta.url), 'utf8')).version || '') }
  catch { return '' }
})()

// 主界面 React 前端构建配置：
//   dev   → 产物在 frontend/dist（不污染 public/，线上 pi-web 可用）
//   发布  → 手动把 dist 产物复制到 public（/static 或根），替换旧 vanilla 入口
// 独立开发：dev 时 /api 代理到本地 pi-web（8787），便于联调
export default defineConfig({
  plugins: [react(), UnoCSS()],
  base: './',  // 相对路径，构建产物可放任意子目录（如 public/react/）
  define: {
    __PRODUCT_VERSION__: JSON.stringify(PRODUCT_VERSION),
  },
  build: {
    outDir: 'dist',        // 独立输出，绝不覆盖 public/
    // 保留上一版指纹资源，避免手机/桌面端仍在运行旧主包时，懒加载模块变成 404。
    // 新入口通过 no-cache 自动更新；旧资源多留一段时间不会影响当前版本。
    emptyOutDir: false,
    rollupOptions: {
      input: 'index.html',
    },
  },
  server: {
    port: 5173,
    // 钉死 IPv4 回环：默认可能只绑 [::1]，配合系统代理时本机都连不上
    host: '127.0.0.1',
    // 不接受虚拟网卡/远程转发带来的 Host；开发页只给本机浏览器联调。
    // 这不能替代关闭旧进程，但能阻止后续启动的 Vite 服务被当作内网网页入口。
    allowedHosts: ['localhost', '127.0.0.1'],
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/static': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
})

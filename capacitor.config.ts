import type { CapacitorConfig } from '@capacitor/cli';

/**
 * 元枢移动端 Capacitor 配置（2026-08-20）
 *
 * 包元枢 React 前端构建产物（frontend/dist/）。
 * frontend/ 是唯一前端源码和构建入口，避免 Capacitor 与 Tauri 使用不同版本。
 *
 * CapacitorHttp 开启：WKWebView/Android WebView 的 origin 是
 * capacitor://localhost（iOS）/http://localhost（Android），跨域请求会被
 * CORS 拦——插件把 fetch/XMLHttpRequest 走原生层，绕过 CORS。
 *
 * server.url 不写死：运行时由前端 config 决定 API 地址（本地 127.0.0.1:8787
 * 或公网域名），App Store/Play 提交版在构建时注入。
 */
const config: CapacitorConfig = {
  appId: 'com.pixinyu.app',
  appName: '元枢',
  webDir: 'frontend/dist',

  ios: {
    contentInset: 'never',
    backgroundColor: '#0e1116',
    scrollEnabled: true,
    limitsNavigationsToAppBoundDomains: false,
  },
  android: {
    backgroundColor: '#0e1116',
    allowMixedContent: false,
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 200,
      backgroundColor: '#0e1116',
    },
    // Capacitor 8 内置 SystemBars 插件默认用 CSS 模式垫充 insets/加道床，
    // 造成状态栏区域一层与主题不符的深灰。disable 后页面像素直接延伸到
    // 状态栏底下，颜色随前端主题/壁纸走；顶部安全距离由 CSS 兑底 24px。
    SystemBars: {
      insetsHandling: 'disable',
    },
  },
};

export default config;

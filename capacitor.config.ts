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
    backgroundColor: '#0d1117',
    scrollEnabled: true,
    limitsNavigationsToAppBoundDomains: false,
  },
  android: {
    backgroundColor: '#0d1117',
    allowMixedContent: false,
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 200,
      backgroundColor: '#0d1117',
    },
  },
};

export default config;

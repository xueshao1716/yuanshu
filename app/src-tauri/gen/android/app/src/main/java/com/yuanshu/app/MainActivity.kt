package com.yuanshu.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private val downloads = YuanshuDownloads(this)
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // 通知权限（Android 13+ 需要运行时申请，否则保活通知/任务完成通知都发不出来）
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
        ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1001)
      }
    }

    // 保活前台服务：进程别被系统轻易杀掉，任务完成提醒才靠谱
    val svcIntent = Intent(this, KeepAliveService::class.java)
    ContextCompat.startForegroundService(this, svcIntent)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    // 原生桥接：不管 WebView 里加载的是本地连接页还是用户自己填的远程 pi-web 地址，都能拿到这几个原生能力
    webView.addJavascriptInterface(YuanshuBridge(this, webView), "YuanshuBridge")
    downloads.attach(webView)
    webView.addJavascriptInterface(downloads, "YuanshuDownloads")
    webView.addJavascriptInterface(YuanshuPush(applicationContext), "YuanshuPush")

    // 某些 Android/WebView 组合（尤其是 edge-to-edge 下的厂商 WebView）不会把 IME
    // 反映到布局高度，导致前端的 visualViewport 也看不到键盘。把系统报告的真实
    // IME bottom inset 转成稳定 DOM 事件，前端只在布局没有自行缩短时使用它兜底。
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view: View, insets: WindowInsetsCompat ->
      val imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      val density = view.resources.displayMetrics.density.coerceAtLeast(1f)
      val cssIme = (imeBottom / density).toInt()
      val script = """
        (function() {
          window.dispatchEvent(new CustomEvent('yuanshu-ime', {
            detail: { height: $cssIme, visible: ${imeBottom > 0} }
          }));
        })();
      """.trimIndent()
      view.post { (view as? WebView)?.evaluateJavascript(script, null) }
      insets
    }
    ViewCompat.requestApplyInsets(webView)
  }

  // 前台时页面自己会提示，原生后台推送据此不重复弹
  override fun onStart() {
    super.onStart()
    PushListener.visible = true
  }

  override fun onStop() {
    PushListener.visible = false
    super.onStop()
  }

  override fun onDestroy() {
    downloads.dispose()
    super.onDestroy()
  }
}

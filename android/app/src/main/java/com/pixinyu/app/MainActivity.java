package com.pixinyu.app;

import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

/**
 * 2026-10-12 手机壳键盘避让（回归修复）：
 * 上轮修状态栏时把 SystemBars 的 insetsHandling 整关（页面像素直铺状态栏），
 * 连带把 Capacitor 默认的键盘 inset 兜底也关了——软键盘一弹直接盖住输入框。
 * 现在把 Tauri 包同一套契约落在这里：读取真实 IME bottom inset（物理像素），
 * 换 CSS 像素后派发 yuanshu-ime 事件；前端 viewport.ts 已经消费这个事件，
 * 且只在布局没有自行缩短时用它兜底，不会双重缩短。
 */
public class MainActivity extends BridgeActivity {
    // 必须在 Activity 构造期注册系统保存窗口的回调（STARTED 之后注册会抛异常）
    private final YuanshuDownloads downloads = new YuanshuDownloads(this);

    @Override
    public void onStart() {
        super.onStart();
        WebView webView = this.bridge.getWebView();
        if (webView == null) return;
        downloads.attach(webView);
        webView.addJavascriptInterface(downloads, "YuanshuDownloads");
        ViewCompat.setOnApplyWindowInsetsListener(webView, (view, insets) -> {
            int imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
            float density = view.getResources().getDisplayMetrics().density;
            float safeDensity = Math.max(1f, density);
            long cssIme = Math.round(imeBottom / safeDensity);
            String script = "(function(){window.dispatchEvent(new CustomEvent('yuanshu-ime',"
                + "{detail:{height:" + cssIme + ",visible:" + (imeBottom > 0) + "}}));})();";
            view.post(() -> {
                if (view instanceof WebView) {
                    ((WebView) view).evaluateJavascript(script, null);
                }
            });
            return insets;
        });
        ViewCompat.requestApplyInsets(webView);
    }

    @Override
    public void onDestroy() {
        downloads.dispose();
        super.onDestroy();
    }
}

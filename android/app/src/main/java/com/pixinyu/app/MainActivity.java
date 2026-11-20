package com.pixinyu.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
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
    private final YuanshuPhone phone = new YuanshuPhone(this);
    private final YuanshuUpdate update = new YuanshuUpdate(this);

    @Override
    public void onStart() {
        super.onStart();
        PushService.visible = true;
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1001);
        }
        WebView webView = this.bridge.getWebView();
        if (webView == null) return;
        downloads.attach(webView);
        webView.addJavascriptInterface(downloads, "YuanshuDownloads");
        webView.addJavascriptInterface(new YuanshuPush(getApplicationContext()), "YuanshuPush");
        webView.addJavascriptInterface(phone, "YuanshuPhone");
        update.attach(webView);
        webView.addJavascriptInterface(update, "YuanshuUpdate");
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
    public void onResume() {
        super.onResume();
        // 从系统设置（无障碍/通知使用权/权限）回来：把最新能力告诉服务器，并刷新设置页
        if (PhoneControl.anyOn(this)) phone.kick();
        WebView wv = this.bridge == null ? null : this.bridge.getWebView();
        if (wv != null) wv.evaluateJavascript("window.dispatchEvent(new Event('yuanshu-phone-state'))", null);
        handleAssist(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleAssist(intent);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == 2001) {
            phone.kick();
            WebView wv = this.bridge == null ? null : this.bridge.getWebView();
            if (wv != null) wv.evaluateJavascript("window.dispatchEvent(new Event('yuanshu-phone-state'))", null);
        }
    }

    /** 被设为默认数字助理后，长按电源/主页键会以 ACTION_ASSIST 打开：直接进语音对话。 */
    private void handleAssist(Intent intent) {
        if (intent == null || !Intent.ACTION_ASSIST.equals(intent.getAction()) && !Intent.ACTION_VOICE_COMMAND.equals(intent.getAction())) return;
        intent.setAction(Intent.ACTION_MAIN);
        WebView wv = this.bridge == null ? null : this.bridge.getWebView();
        if (wv != null) wv.postDelayed(() -> wv.evaluateJavascript("window.dispatchEvent(new Event('yuanshu-assist'))", null), 600);
    }

    @Override
    public void onStop() {
        PushService.visible = false;
        super.onStop();
    }

    @Override
    public void onDestroy() {
        downloads.dispose();
        super.onDestroy();
    }
}

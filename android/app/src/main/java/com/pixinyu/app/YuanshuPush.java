package com.pixinyu.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.webkit.JavascriptInterface;
import androidx.core.content.ContextCompat;

/**
 * 给页面的后台推送桥（window.YuanshuPush），契约与 Tauri 壳的同名桥一致：
 *   configure(baseUrl, token)  登录后交出服务器地址与令牌，原生前台服务开始监听
 *   clear()                    退出登录，停止监听并忘掉令牌
 *   ack(seq)                   页面已处理该通知，原生不必再弹
 */
public class YuanshuPush {
    private final Context context;
    private final SharedPreferences prefs;

    YuanshuPush(Context context) {
        this.context = context.getApplicationContext();
        this.prefs = this.context.getSharedPreferences(PushService.PREFS, Context.MODE_PRIVATE);
    }

    @JavascriptInterface
    public void configure(String baseUrl, String token) {
        prefs.edit().putString("baseUrl", baseUrl.trim().replaceAll("/+$", "")).putString("token", token).apply();
        kick();
    }

    @JavascriptInterface
    public void clear() {
        prefs.edit().remove("baseUrl").remove("token").apply();
        context.stopService(new Intent(context, PushService.class));
    }

    @JavascriptInterface
    public void ack(double seq) {
        if ((long) seq > PushService.acked) PushService.acked = (long) seq;
    }

    /** 启动（或让已运行的服务按最新配置重连）；服务内部发现配置没变就什么也不做 */
    private void kick() {
        try { ContextCompat.startForegroundService(context, new Intent(context, PushService.class)); } catch (Exception ignored) { }
    }
}

package com.pixinyu.app;

import android.content.Context;
import android.webkit.JavascriptInterface;

/**
 * 快速唤起补拉（window.YuanshuFlash，2026-11-23 v2.231.1）：
 *   takePending()  页面挂好后主动来取「还没消费的唤起意图」，返回 "assist" / "new-chat" / ""
 *   consumed()     页面上已经收到事件了，原生不用再重发
 *   setTheme(json) 主程序当前主题色（2026-11-23 v2.235.0），存进本地给「问小语」浮层用，卡片跟主程序一个颜色
 *
 * 为什么要有这个：磁贴点下去时 Activity 先起来，页面还在冷启动（首次要解析整包 JS、
 * 还要等登录态），这时 evaluateJavascript 派发的事件落在还没有监听者的 window 上，直接丢。
 * 把意图存内存里让页面来取，时序就不重要了——页面多慢都拿得到。
 */
public class YuanshuFlash {
    static final String KEY_THEME = "assistTheme";
    private String pending = "";
    private Context app;

    void attach(Context c) { app = c.getApplicationContext(); }

    @JavascriptInterface
    public void setTheme(String json) {
        Context c = app;
        if (c == null || json == null || json.length() > 4000) return;
        c.getSharedPreferences(PushService.PREFS, Context.MODE_PRIVATE).edit().putString(KEY_THEME, json).apply();
    }

    @JavascriptInterface
    public String takePending() {
        synchronized (this) {
            String p = pending;
            pending = "";
            return p;
        }
    }

    @JavascriptInterface
    public void consumed() { clear(); }

    synchronized void setPending(String event) { pending = event; }

    synchronized boolean hasPending() { return !pending.isEmpty(); }

    synchronized void clear() { pending = ""; }
}

package com.pixinyu.app;

import android.webkit.JavascriptInterface;

/**
 * 快速唤起补拉（window.YuanshuFlash，2026-11-23 v2.231.1）：
 *   takePending()  页面挂好后主动来取「还没消费的唤起意图」，返回 "assist" / "new-chat" / ""
 *   consumed()     页面上已经收到事件了，原生不用再重发
 *
 * 为什么要有这个：磁贴点下去时 Activity 先起来，页面还在冷启动（首次要解析整包 JS、
 * 还要等登录态），这时 evaluateJavascript 派发的事件落在还没有监听者的 window 上，直接丢。
 * 把意图存内存里让页面来取，时序就不重要了——页面多慢都拿得到。
 */
public class YuanshuFlash {
    private String pending = "";

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

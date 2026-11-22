package com.pixinyu.app;

import android.webkit.JavascriptInterface;
import android.webkit.WebView;

/**
 * 界面字号（window.YuanshuDisplay，2026-11-22）：
 *   textZoom(percent)  主题页「界面缩放」在手机 App 里走 WebView 原生文字缩放。
 *                      CSS zoom 会把 vw/vh 一起放大，手机上弹窗会撑出屏幕；文字缩放只放大字、布局自己重排。
 */
public class YuanshuDisplay {
    private WebView webView;

    void attach(WebView view) { webView = view; }

    @JavascriptInterface
    public void textZoom(int percent) {
        WebView wv = webView;
        if (wv == null) return;
        int p = Math.max(80, Math.min(150, percent));
        wv.post(() -> wv.getSettings().setTextZoom(p));
    }
}

package com.yuanshu.app

import android.content.Context
import android.content.Intent
import android.webkit.JavascriptInterface
import androidx.core.content.ContextCompat

/**
 * 给页面的后台推送桥（window.YuanshuPush），契约与 Capacitor 壳同名桥一致：
 *   configure(baseUrl, token)  登录后交出服务器地址与令牌，原生服务开始监听
 *   clear()                    退出登录，停止监听并忘掉令牌
 *   ack(seq)                   页面已处理该通知，原生不必再弹
 */
class YuanshuPush(private val ctx: Context) {
    private val prefs = ctx.getSharedPreferences(PushListener.PREFS, Context.MODE_PRIVATE)

    @JavascriptInterface
    fun configure(baseUrl: String, token: String) {
        prefs.edit().putString("baseUrl", baseUrl.trim().trimEnd('/')).putString("token", token).apply()
        kick()
    }

    @JavascriptInterface
    fun clear() {
        prefs.edit().remove("baseUrl").remove("token").apply()
        kick()
    }

    @JavascriptInterface
    fun ack(seq: Double) {
        if (seq.toLong() > PushListener.acked) PushListener.acked = seq.toLong()
    }

    /** 让保活服务按最新配置（重）启动或停止监听线程 */
    private fun kick() {
        try { ContextCompat.startForegroundService(ctx, Intent(ctx, KeepAliveService::class.java)) } catch (_: Exception) {}
    }
}

package com.yuanshu.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * 保活前台服务：把进程优先级提上去，别让 Android 把 App 连同 WebView 一起杀掉；
 * 同时（登录后）在这里跑 PushListener，App 进后台、WebView 被冻结时仍由原生读通知流并弹系统通知。
 * 常驻通知优先级 LOW（无提示音无震动），不会打扰。
 * 前台服务类型：Android 14+ 用 specialUse（dataSync 在 Android 15 有 6 小时超时），更早版本用 dataSync。
 */
class KeepAliveService : Service() {

    companion object {
        const val CHANNEL_ID = "yuanshu_keepalive"
        const val NOTIF_ID = 1001
    }

    private lateinit var push: PushListener

    override fun onCreate() {
        super.onCreate()
        push = PushListener(applicationContext)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                val ch = NotificationChannel(CHANNEL_ID, "保持连接", NotificationManager.IMPORTANCE_LOW)
                ch.description = "元枢在后台保持连接，任务完成才能及时提醒你"
                ch.setShowBadge(false)
                nm.createNotificationChannel(ch)
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_recent_history)
            .setContentTitle("元枢 · 正在保持连接")
            .setContentText("任务完成会在这里提醒你")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        try {
            when {
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE ->
                    startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ->
                    startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
                else -> startForeground(NOTIF_ID, notification)
            }
        } catch (_: Exception) {
            // 系统此刻不允许升为前台（如后台重启限制）：不崩，等用户下次打开 App 再起
            stopSelf()
            return START_NOT_STICKY
        }
        push.ensureRunning()
        return START_STICKY
    }

    override fun onDestroy() {
        push.stop()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}

package com.yuanshu.app

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * 原生后台推送：App 进后台后 WebView 会被冻结，页面里的 /api/notify/stream 随之停摆，
 * 所以由前台服务里的这个线程自己读同一条 SSE，并把每个事件弹成系统通知。
 * 游标 seq 存 SharedPreferences：重连/重启都带 ?after=，不重复也不丢。
 * 去重：页面处理过的事件会经 YuanshuPush.ack 上报；App 在前台时也不弹（页面自己会提示）。
 */
class PushListener(private val ctx: Context) {

    companion object {
        const val PREFS = "yuanshu_push"
        const val CHANNEL = "yuanshu_push"
        @Volatile var visible = false   // MainActivity onStart/onStop 维护
        @Volatile var acked = 0L        // 页面已处理到的最大 seq
    }

    private val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private var thread: Thread? = null
    private var signature = ""
    @Volatile private var conn: HttpURLConnection? = null

    /** 配置没变且线程还活着就什么都不做；否则按当前配置重启。没有配置则停掉。 */
    @Synchronized fun ensureRunning() {
        val base = prefs.getString("baseUrl", "").orEmpty()
        val token = prefs.getString("token", "").orEmpty()
        if (base.isEmpty() || token.isEmpty()) { stop(); return }
        if (thread?.isAlive == true && signature == base + "\n" + token) return
        stop()
        signature = base + "\n" + token
        val t = Thread({ loop(base, token) }, "yuanshu-push")
        t.isDaemon = true
        thread = t
        t.start()
    }

    @Synchronized fun stop() {
        thread?.interrupt()
        thread = null
        signature = ""
        try { conn?.disconnect() } catch (_: Exception) {}
    }

    private fun mine() = Thread.currentThread() === thread

    private fun cursor(base: String): Long =
        if (prefs.getString("cursorBase", "") == base) prefs.getLong("cursor", -1) else -1

    private fun saveCursor(base: String, seq: Long) {
        prefs.edit().putString("cursorBase", base).putLong("cursor", seq).apply()
    }

    private fun loop(base: String, token: String) {
        var backoff = 2000L
        while (mine()) {
            try {
                val after = cursor(base)
                val c = URL("$base/api/notify/stream" + if (after >= 0) "?after=$after" else "").openConnection() as HttpURLConnection
                conn = c
                c.setRequestProperty("Authorization", "Bearer $token")
                c.setRequestProperty("Accept", "text/event-stream")
                c.connectTimeout = 15000
                c.readTimeout = 60000 // 服务端每 20 秒发一次 ping，60 秒没动静就当断线
                if (c.responseCode != 200) throw IllegalStateException("HTTP ${c.responseCode}")
                backoff = 2000L
                c.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
                    var type = "message"
                    val data = StringBuilder()
                    while (mine()) {
                        val line = reader.readLine() ?: break
                        when {
                            line.isEmpty() -> { if (data.isNotEmpty()) handle(base, type, data.toString()); type = "message"; data.setLength(0) }
                            line.startsWith("event:") -> type = line.substring(6).trim()
                            line.startsWith("data:") -> { if (data.isNotEmpty()) data.append('\n'); data.append(line.substring(5).trimStart()) }
                        }
                    }
                }
            } catch (_: InterruptedException) {
                return
            } catch (_: Exception) {
                // 断线/超时/服务端重启：退避重连
            }
            if (!mine()) return
            try { Thread.sleep(backoff) } catch (_: InterruptedException) { return }
            backoff = (backoff * 2).coerceAtMost(60000L)
        }
    }

    private fun handle(base: String, type: String, data: String) {
        val j = try { JSONObject(data) } catch (_: Exception) { return }
        if (type == "subscribed") {
            val last = j.optLong("lastSeq", 0)
            val cur = cursor(base)
            if (cur < 0 || cur > last) saveCursor(base, last) // 首次只收以后的；服务端数据被重置则回落
            if (acked > last) acked = last
        } else if (type == "notify") {
            val seq = j.optLong("seq", -1)
            if (seq < 0 || seq <= cursor(base)) return
            saveCursor(base, seq)
            // 刚发生的事件先等一会儿，让还醒着的页面有机会 ack，避免页面和原生各弹一次
            if (System.currentTimeMillis() - j.optLong("ts") < 10000) Thread.sleep(1500)
            if (visible || acked >= seq) return
            show(seq, j.optString("title", "元枢").ifBlank { "元枢" }, j.optString("body"))
        }
    }

    private fun show(seq: Long, title: String, body: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = ctx.getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL) == null) {
                val ch = NotificationChannel(CHANNEL, "主动通知", NotificationManager.IMPORTANCE_HIGH)
                ch.description = "任务做完、智能体主动汇报时提醒你"
                nm.createNotificationChannel(ch)
            }
        }
        val open = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return
        val tap = PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        try { NotificationManagerCompat.from(ctx).notify(3000 + (seq % 1000).toInt(), n) } catch (_: SecurityException) {}
    }
}

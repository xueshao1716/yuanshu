package com.pixinyu.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * 原生后台推送前台服务：App 进后台后 WebView 会被冻结，页面里的 /api/notify/stream 随之停摆，
 * 所以由这个服务自己读同一条 SSE，把每个事件弹成系统通知（tap 打开 App）。
 * 游标 seq 存 SharedPreferences：重连/重启都带 ?after=，不重复也不丢。
 * 去重：页面处理过的事件经 YuanshuPush.ack 上报；App 在前台时也不弹（页面自己会提示）。
 * 前台服务类型：Android 14+ 用 specialUse（dataSync 在 Android 15 有 6 小时超时），更早版本用 dataSync。
 * 服务只在登录后（YuanshuPush.configure）才启动，退出登录（clear）即停。
 */
public class PushService extends Service {
    static final String PREFS = "yuanshu_push";
    private static final String CH_KEEP = "yuanshu_push_keepalive";
    private static final String CH_PUSH = "yuanshu_push";
    private static final int NOTIF_KEEP = 1001;

    /** MainActivity onStart/onStop 维护：前台时不弹 */
    static volatile boolean visible = false;
    /** 页面已处理到的最大 seq */
    static volatile long acked = 0;

    private SharedPreferences prefs;
    private Thread thread;
    private String signature = "";
    private volatile HttpURLConnection conn;

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            nm.createNotificationChannel(channel(CH_KEEP, "保持连接", NotificationManager.IMPORTANCE_LOW, "元枢在后台保持连接，任务完成才能及时提醒你"));
            nm.createNotificationChannel(channel(CH_PUSH, "主动通知", NotificationManager.IMPORTANCE_HIGH, "任务做完、智能体主动汇报时提醒你"));
        }
    }

    private static NotificationChannel channel(String id, String name, int importance, String desc) {
        NotificationChannel ch = new NotificationChannel(id, name, importance);
        ch.setDescription(desc);
        return ch;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification keep = new NotificationCompat.Builder(this, CH_KEEP)
            .setSmallIcon(android.R.drawable.ic_menu_recent_history)
            .setContentTitle("元枢 · 正在保持连接")
            .setContentText("任务完成会在这里提醒你")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIF_KEEP, keep, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_KEEP, keep, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIF_KEEP, keep);
            }
        } catch (Exception e) {
            // 系统此刻不允许升为前台（如后台重启限制）：不崩，等用户下次打开 App 再起
            stopSelf();
            return START_NOT_STICKY;
        }
        ensureRunning();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopListening();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    /** 配置没变且线程还活着就什么都不做；否则按当前配置重启；没有配置则停服务。 */
    private synchronized void ensureRunning() {
        final String base = prefs.getString("baseUrl", "");
        final String token = prefs.getString("token", "");
        if (base.isEmpty() || token.isEmpty()) { stopListening(); stopSelf(); return; }
        if (thread != null && thread.isAlive() && signature.equals(base + "\n" + token)) return;
        stopListening();
        signature = base + "\n" + token;
        thread = new Thread(() -> loop(base, token), "yuanshu-push");
        thread.setDaemon(true);
        thread.start();
    }

    private synchronized void stopListening() {
        if (thread != null) thread.interrupt();
        thread = null;
        signature = "";
        HttpURLConnection c = conn;
        if (c != null) c.disconnect();
    }

    private boolean mine() { return Thread.currentThread() == thread; }

    private long cursor(String base) {
        return base.equals(prefs.getString("cursorBase", "")) ? prefs.getLong("cursor", -1) : -1;
    }

    private void saveCursor(String base, long seq) {
        prefs.edit().putString("cursorBase", base).putLong("cursor", seq).apply();
    }

    private void loop(String base, String token) {
        long backoff = 2000;
        while (mine()) {
            try {
                long after = cursor(base);
                HttpURLConnection c = (HttpURLConnection) new URL(base + "/api/notify/stream" + (after >= 0 ? "?after=" + after : "")).openConnection();
                conn = c;
                c.setRequestProperty("Authorization", "Bearer " + token);
                c.setRequestProperty("Accept", "text/event-stream");
                c.setConnectTimeout(15000);
                c.setReadTimeout(60000); // 服务端每 20 秒发一次 ping，60 秒没动静就当断线
                if (c.getResponseCode() != 200) throw new IllegalStateException("HTTP " + c.getResponseCode());
                backoff = 2000;
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
                    String type = "message";
                    StringBuilder data = new StringBuilder();
                    String line;
                    while (mine() && (line = reader.readLine()) != null) {
                        if (line.isEmpty()) {
                            if (data.length() > 0) handle(base, type, data.toString());
                            type = "message";
                            data.setLength(0);
                        } else if (line.startsWith("event:")) {
                            type = line.substring(6).trim();
                        } else if (line.startsWith("data:")) {
                            if (data.length() > 0) data.append('\n');
                            data.append(line.substring(5).trim());
                        }
                    }
                }
            } catch (InterruptedException e) {
                return;
            } catch (Exception e) {
                // 断线/超时/服务端重启：退避重连
            }
            if (!mine()) return;
            try { Thread.sleep(backoff); } catch (InterruptedException e) { return; }
            backoff = Math.min(backoff * 2, 60000);
        }
    }

    private void handle(String base, String type, String data) throws InterruptedException {
        JSONObject j;
        try { j = new JSONObject(data); } catch (Exception e) { return; }
        if (type.equals("subscribed")) {
            long last = j.optLong("lastSeq", 0);
            long cur = cursor(base);
            if (cur < 0 || cur > last) saveCursor(base, last); // 首次只收以后的；服务端数据被重置则回落
            if (acked > last) acked = last;
        } else if (type.equals("notify")) {
            long seq = j.optLong("seq", -1);
            if (seq < 0 || seq <= cursor(base)) return;
            saveCursor(base, seq);
            // 刚发生的事件先等一会儿，让还醒着的页面有机会 ack，避免页面和原生各弹一次
            if (System.currentTimeMillis() - j.optLong("ts") < 10000) Thread.sleep(1500);
            if (visible || acked >= seq) return;
            String title = j.optString("title", "");
            show(seq, title.trim().isEmpty() ? "元枢" : title, j.optString("body", ""));
        }
    }

    private void show(long seq, String title, String body) {
        if (Build.VERSION.SDK_INT >= 33
            && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (open == null) return;
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(this, CH_PUSH)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build();
        try { NotificationManagerCompat.from(this).notify(3000 + (int) (seq % 1000), n); } catch (SecurityException ignored) { }
    }
}

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
import java.io.OutputStream;
import java.net.URLEncoder;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
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
    // 2026-11-20 手机控制：第二条连接 /api/phone/stream 收指令（只在「手机控制」里开了至少一项时连）
    private Thread phoneThread;
    private String phoneSignature = "";
    private volatile HttpURLConnection phoneConn;
    private final ExecutorService workers = Executors.newFixedThreadPool(3);
    private PhoneCommands commands;

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        commands = new PhoneCommands(this);
        PhoneControl.installCrashCatcher(this);
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
        stopPhone();
        workers.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    /** 配置没变且线程还活着就什么都不做；否则按当前配置重启；没有配置则停服务。 */
    private synchronized void ensureRunning() {
        final String base = prefs.getString("baseUrl", "");
        final String token = prefs.getString("token", "");
        if (base.isEmpty() || token.isEmpty()) { stopListening(); stopPhone(); stopSelf(); return; }
        ensurePhone(base, token);
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

    // ================= 手机控制通道 =================

    private synchronized void ensurePhone(String base, String token) {
        if (!PhoneControl.anyOn(this)) { stopPhone(); return; }
        String sig = base + "\n" + token;
        if (phoneThread != null && phoneThread.isAlive() && phoneSignature.equals(sig)) { hello(base, token); return; }
        stopPhone();
        phoneSignature = sig;
        phoneThread = new Thread(() -> phoneLoop(base, token), "yuanshu-phone");
        phoneThread.setDaemon(true);
        phoneThread.start();
    }

    private synchronized void stopPhone() {
        if (phoneThread != null) phoneThread.interrupt();
        phoneThread = null;
        phoneSignature = "";
        HttpURLConnection c = phoneConn;
        if (c != null) c.disconnect();
    }

    private boolean phoneMine() { return Thread.currentThread() == phoneThread; }

    private void phoneLoop(String base, String token) {
        long backoff = 2000;
        while (phoneMine()) {
            try {
                String q = "?device=" + enc(PhoneControl.deviceId(this)) + "&name=" + enc(PhoneControl.deviceName())
                    + "&model=" + enc(Build.MODEL) + "&android=" + enc(Build.VERSION.RELEASE)
                    + "&caps=" + enc(String.join(",", PhoneControl.activeCaps(this)));
                HttpURLConnection c = (HttpURLConnection) new URL(base + "/api/phone/stream" + q).openConnection();
                phoneConn = c;
                c.setRequestProperty("Authorization", "Bearer " + token);
                c.setRequestProperty("Accept", "text/event-stream");
                c.setConnectTimeout(15000);
                c.setReadTimeout(60000);
                if (c.getResponseCode() != 200) throw new IllegalStateException("HTTP " + c.getResponseCode());
                backoff = 2000;
                if (PhoneControl.hasCrash(this)) hello(base, token); // 上次崩溃的堆栈报给服务器
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
                    String type = "message";
                    StringBuilder data = new StringBuilder();
                    String line;
                    while (phoneMine() && (line = reader.readLine()) != null) {
                        if (line.isEmpty()) {
                            if (data.length() > 0 && type.equals("cmd")) dispatch(base, token, data.toString());
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
            } catch (Exception e) {
                // 断线/超时/服务器重启：退避重连
            }
            if (!phoneMine()) return;
            try { Thread.sleep(backoff); } catch (InterruptedException e) { return; }
            backoff = Math.min(backoff * 2, 60000);
        }
    }

    // 断线重连后服务器会重发没拿到结果的指令：执行中的不重复做，做完的直接补发结果
    private final java.util.Set<String> running = java.util.Collections.newSetFromMap(new java.util.concurrent.ConcurrentHashMap<>());
    private final java.util.Map<String, JSONObject> finished = java.util.Collections.synchronizedMap(new java.util.LinkedHashMap<String, JSONObject>() {
        @Override protected boolean removeEldestEntry(java.util.Map.Entry<String, JSONObject> e) { return size() > 50; }
    });

    private void dispatch(String base, String token, String data) {
        final JSONObject j;
        try { j = new JSONObject(data); } catch (Exception e) { return; }
        String cid = j.optString("id");
        JSONObject prev = finished.get(cid);
        if (prev != null) { workers.submit(() -> postResult(base, token, prev)); return; }
        if (!running.add(cid)) return;
        workers.submit(() -> {
            String id = j.optString("id");
            JSONObject out = new JSONObject();
            try {
                out.put("deviceId", PhoneControl.deviceId(this)).put("id", id);
                JSONObject args = j.optJSONObject("args");
                Object r = commands.run(id, j.optString("cmd"), args == null ? new JSONObject() : args);
                out.put("ok", true).put("data", r);
            } catch (Throwable e) {
                try { out.put("ok", false).put("error", e.getMessage() == null ? e.toString() : e.getMessage()); } catch (Exception ignored) { }
            }
            finished.put(id, out);
            running.remove(id);
            postResult(base, token, out);
        });
    }

    /** 回传结果；网络刚切换时可能失败，重试几次。 */
    private static void postResult(String base, String token, JSONObject out) {
        for (int i = 0; i < 4; i++) {
            if (post(base, token, "/api/phone/result", out)) return;
            try { Thread.sleep(1500L * (i + 1)); } catch (InterruptedException e) { return; }
        }
    }

    /** 能力开关变了：告诉服务器（不用断开重连）。 */
    private void hello(String base, String token) {
        workers.submit(() -> {
            try {
                JSONObject b = new JSONObject().put("deviceId", PhoneControl.deviceId(this))
                    .put("caps", new org.json.JSONArray(PhoneControl.activeCaps(this)));
                String crash = PhoneControl.takeCrash(this);
                if (!crash.isEmpty()) b.put("lastError", crash);
                post(base, token, "/api/phone/hello", b);
            } catch (Exception ignored) { }
        });
    }

    private static boolean post(String base, String token, String path, JSONObject body) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setRequestProperty("Authorization", "Bearer " + token);
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            try (OutputStream os = c.getOutputStream()) { os.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
            int code = c.getResponseCode();
            c.disconnect();
            return code < 500;
        } catch (Exception ignored) { return false; }
    }

    private static String enc(String s) {
        try { return URLEncoder.encode(s == null ? "" : s, "UTF-8"); } catch (Exception e) { return ""; }
    }

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

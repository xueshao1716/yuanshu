package com.pixinyu.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 手机上的人工确认（打电话、发短信、点「发送/支付/删除」、首次允许操作屏幕）。
 * 弹一条高优先级通知，「允许」「拒绝」两个按钮都打开 ConfirmActivity（用户亲手点的，
 * 所以之后从这个 Activity 发起拨号等界面跳转不受后台启动限制）。
 */
public final class Confirmations {
    static final String CH = "yuanshu_confirm";

    interface OnAllow { void run(Context activityContext) throws Exception; }

    static final class Req {
        final String title, body;
        final OnAllow onAllow;
        final CountDownLatch latch = new CountDownLatch(1);
        volatile boolean allowed = false;
        volatile String error = null;
        Req(String title, String body, OnAllow onAllow) { this.title = title; this.body = body; this.onAllow = onAllow; }
    }

    static final Map<String, Req> pending = new ConcurrentHashMap<>();

    private Confirmations() { }

    /** 阻塞等用户回答；超时或拒绝抛异常。onAllow 在用户点允许的那个 Activity 里执行。 */
    static void ask(Context ctx, String id, String title, String body, OnAllow onAllow, long timeoutMs) throws Exception {
        Req r = new Req(title, body, onAllow);
        pending.put(id, r);
        int nid = 5000 + Math.abs(id.hashCode() % 1000);
        try {
            show(ctx, id, nid, r);
            if (!r.latch.await(timeoutMs, TimeUnit.MILLISECONDS)) throw new Exception("手机上没有人确认（已超时），未执行");
            if (!r.allowed) throw new Exception("用户在手机上拒绝了，未执行");
            if (r.error != null) throw new Exception(r.error);
        } finally {
            pending.remove(id);
            NotificationManagerCompat.from(ctx).cancel(nid);
        }
    }

    /** ConfirmActivity 调：记下结果，允许时在 Activity 里执行动作。 */
    static void settle(Context activity, String id, boolean allow) {
        Req r = pending.get(id);
        if (r == null) return;
        if (allow && r.onAllow != null) {
            try { r.onAllow.run(activity); } catch (Exception e) { r.error = "执行失败：" + e.getMessage(); }
        }
        r.allowed = allow;
        r.latch.countDown();
    }

    private static void show(Context ctx, String id, int nid, Req r) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CH, "操作确认", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("元枢要替你打电话、发短信或点关键按钮时，在这里等你点允许");
            ctx.getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
        PendingIntent allow = action(ctx, id, true, nid * 2);
        PendingIntent deny = action(ctx, id, false, nid * 2 + 1);
        Intent open = new Intent(ctx, ConfirmActivity.class).putExtra("id", id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent tap = PendingIntent.getActivity(ctx, nid * 2 + 2, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(ctx, CH)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle(r.title)
            .setContentText(r.body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(r.body))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setContentIntent(tap)
            .setFullScreenIntent(tap, true)
            .setAutoCancel(true)
            .addAction(0, "拒绝", deny)
            .addAction(0, "允许", allow)
            .build();
        try { NotificationManagerCompat.from(ctx).notify(nid, n); } catch (SecurityException ignored) { }
    }

    private static PendingIntent action(Context ctx, String id, boolean allow, int code) {
        Intent i = new Intent(ctx, ConfirmActivity.class).putExtra("id", id).putExtra("answer", allow ? "allow" : "deny").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(ctx, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
}

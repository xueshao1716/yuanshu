package com.pixinyu.app;

import android.app.Notification;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 读通知：用户在系统「通知使用权」里给了元枢，并在手机控制页打开「读取通知」后才会被用到。
 * 2026-11-21 通知里直接回复：微信/短信等消息通知自带「回复」，用它回消息不用开应用、不碰屏幕。
 */
public class YuanshuNotifs extends NotificationListenerService {
    static volatile YuanshuNotifs instance;

    @Override public void onListenerConnected() { instance = this; }
    @Override public void onListenerDisconnected() { if (instance == this) instance = null; }

    /** 当前通知栏里的通知（跳过自己和常驻/静默的系统通知），最多 limit 条。 */
    JSONArray recent(int limit) throws Exception {
        JSONArray out = new JSONArray();
        StatusBarNotification[] list = getActiveNotifications();
        if (list == null) return out;
        java.util.Arrays.sort(list, (a, b) -> Long.compare(b.getPostTime(), a.getPostTime()));
        for (StatusBarNotification sbn : list) {
            if (out.length() >= limit) break;
            if (sbn.getPackageName().equals(getPackageName()) || sbn.isOngoing()) continue;
            Bundle ex = sbn.getNotification().extras;
            CharSequence title = ex.getCharSequence(Notification.EXTRA_TITLE);
            CharSequence text = ex.getCharSequence(Notification.EXTRA_BIG_TEXT);
            if (text == null) text = ex.getCharSequence(Notification.EXTRA_TEXT);
            if (title == null && text == null) continue;
            out.put(new JSONObject()
                .put("key", sbn.getKey())
                .put("canReply", replyAction(sbn.getNotification()) != null)
                .put("app", appLabel(sbn.getPackageName()))
                .put("package", sbn.getPackageName())
                .put("title", title == null ? "" : title.toString())
                .put("text", text == null ? "" : clip(text.toString(), 300))
                .put("time", sbn.getPostTime()));
        }
        return out;
    }

    /** 通知里带输入框的那个动作（「回复」）；没有就 null。手表扩展里的也算（有的应用只放在那里）。 */
    static Notification.Action replyAction(Notification n) {
        java.util.List<Notification.Action> all = new java.util.ArrayList<>();
        if (n.actions != null) all.addAll(java.util.Arrays.asList(n.actions));
        all.addAll(new Notification.WearableExtender(n).getActions());
        for (Notification.Action a : all) {
            RemoteInput[] ins = a.getRemoteInputs();
            if (ins == null) continue;
            for (RemoteInput r : ins) if (r.getAllowFreeFormInput()) return a;
        }
        return null;
    }

    /** 按 key 找到通知，返回 {app, title}，找不到或不能回复就抛错。 */
    JSONObject replyTarget(String key) throws Exception {
        StatusBarNotification sbn = find(key);
        Bundle ex = sbn.getNotification().extras;
        CharSequence title = ex.getCharSequence(Notification.EXTRA_TITLE);
        return new JSONObject().put("app", appLabel(sbn.getPackageName())).put("title", title == null ? "" : title.toString());
    }

    /** 往通知的「回复」里填字并发出。 */
    void reply(Context ctx, String key, String text) throws Exception {
        StatusBarNotification sbn = find(key);
        Notification.Action a = replyAction(sbn.getNotification());
        Intent fill = new Intent();
        Bundle results = new Bundle();
        for (RemoteInput r : a.getRemoteInputs()) results.putCharSequence(r.getResultKey(), text);
        RemoteInput.addResultsToIntent(a.getRemoteInputs(), fill, results);
        a.actionIntent.send(ctx, 0, fill);
    }

    private StatusBarNotification find(String key) throws Exception {
        StatusBarNotification[] list = getActiveNotifications();
        if (list != null) for (StatusBarNotification s : list) {
            if (!s.getKey().equals(key)) continue;
            if (replyAction(s.getNotification()) == null) throw new Exception("这条通知没有「回复」按钮，只能打开应用回复");
            return s;
        }
        throw new Exception("通知已经不在通知栏里了（可能已读或被清掉），先 notifications 重新看");
    }

    private String appLabel(String pkg) {
        try { return getPackageManager().getApplicationLabel(getPackageManager().getApplicationInfo(pkg, 0)).toString(); }
        catch (Exception e) { return pkg; }
    }

    static String clip(String s, int n) { return s.length() > n ? s.substring(0, n) + "…" : s; }
}

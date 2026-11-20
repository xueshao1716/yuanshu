package com.pixinyu.app;

import android.app.Notification;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import org.json.JSONArray;
import org.json.JSONObject;

/** 读通知：用户在系统「通知使用权」里给了元枢，并在手机控制页打开「读取通知」后才会被用到。 */
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
                .put("app", appLabel(sbn.getPackageName()))
                .put("package", sbn.getPackageName())
                .put("title", title == null ? "" : title.toString())
                .put("text", text == null ? "" : clip(text.toString(), 300))
                .put("time", sbn.getPostTime()));
        }
        return out;
    }

    private String appLabel(String pkg) {
        try { return getPackageManager().getApplicationLabel(getPackageManager().getApplicationInfo(pkg, 0)).toString(); }
        catch (Exception e) { return pkg; }
    }

    static String clip(String s, int n) { return s.length() > n ? s.substring(0, n) + "…" : s; }
}

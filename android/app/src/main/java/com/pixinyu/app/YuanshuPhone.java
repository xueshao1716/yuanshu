package com.pixinyu.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 给页面的手机控制桥（window.YuanshuPhone），「手机控制」设置页用：
 *   state()            → JSON：每项能力 {cap, on, permitted}，以及无障碍/通知使用权是否已开
 *   setCap(cap, on)    打开/关闭一项；打开时顺带申请系统权限，并通知服务器
 *   openAccessibility() / openNotificationAccess() / openAppSettings()  跳系统设置
 *   setBubble(on)      问小语悬浮球（v2.238.0）；setMoneyOnly(on) 点按只在付款/下单/转账前确认
 */
public class YuanshuPhone {
    private final Activity activity;

    YuanshuPhone(Activity activity) { this.activity = activity; }

    @JavascriptInterface
    public String state() {
        try {
            JSONArray caps = new JSONArray();
            for (String cap : PhoneControl.CAPS.keySet()) {
                caps.put(new JSONObject().put("cap", cap).put("on", PhoneControl.switchedOn(activity, cap)).put("permitted", PhoneControl.permitted(activity, cap)));
            }
            return new JSONObject().put("caps", caps)
                .put("accessibility", YuanshuAccess.instance != null)
                .put("notificationAccess", PhoneControl.notificationAccess(activity))
                .put("screenshot", Build.VERSION.SDK_INT >= 30)
                .put("device", PhoneControl.deviceName())
                .put("android", Build.VERSION.RELEASE)
                .put("batteryFree", batteryFree())
                .put("route", Routes.label())
                .put("bubble", YuanshuBubble.enabled(activity))
                .put("moneyOnly", YuanshuAccess.moneyOnly(activity))
                .toString();
        } catch (Exception e) { return "{}"; }
    }

    @JavascriptInterface
    public void setCap(String cap, boolean on) {
        if (!PhoneControl.CAPS.containsKey(cap)) return;
        PhoneControl.setSwitch(activity, cap, on);
        if (on) {
            List<String> need = new ArrayList<>();
            for (String p : PhoneControl.CAPS.get(cap)) if (!PhoneControl.granted(activity, p)) need.add(p);
            if (!need.isEmpty()) activity.runOnUiThread(() -> ActivityCompat.requestPermissions(activity, need.toArray(new String[0]), 2001));
            if (cap.equals("screen") && YuanshuAccess.instance == null) openAccessibility();
            if (cap.equals("notifications") && !PhoneControl.notificationAccess(activity)) openNotificationAccess();
        } else if (cap.equals("screen") && YuanshuAccess.instance != null) {
            YuanshuAccess.instance.revoke();
        }
        kick();
    }

    @JavascriptInterface
    public void setBubble(boolean on) {
        PhoneControl.prefs(activity).edit().putBoolean(YuanshuBubble.PREF_ON, on).apply();
        if (on && YuanshuAccess.instance == null) openAccessibility();
        YuanshuAccess.syncBubble();
    }

    @JavascriptInterface
    public void setMoneyOnly(boolean on) { PhoneControl.prefs(activity).edit().putBoolean(YuanshuAccess.PREF_MONEY_ONLY, on).apply(); }

    @JavascriptInterface
    public void openAccessibility() { open(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)); }

    @JavascriptInterface
    public void openNotificationAccess() { open(new Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS")); }

    @JavascriptInterface
    public void openAppSettings() { open(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + activity.getPackageName()))); }

    /** 设为默认数字助理（长按电源/主页键唤起元枢）。 */
    @JavascriptInterface
    public void openAssistantSettings() {
        Intent i = new Intent(Settings.ACTION_VOICE_INPUT_SETTINGS);
        if (i.resolveActivity(activity.getPackageManager()) == null) i = new Intent(Settings.ACTION_SETTINGS);
        open(i);
    }

    private boolean batteryFree() {
        android.os.PowerManager pm = (android.os.PowerManager) activity.getSystemService(android.content.Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(activity.getPackageName());
    }

    /** 关掉电池优化：荣耀/华为等系统会在元枢切后台时冻结它、掐断指令通道。 */
    @JavascriptInterface
    public void openBatterySettings() {
        Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + activity.getPackageName()));
        if (batteryFree() || i.resolveActivity(activity.getPackageManager()) == null) i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
        open(i);
    }

    private void open(Intent i) {
        activity.runOnUiThread(() -> { try { activity.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) { } });
    }

    /** 让前台服务按最新开关连上/断开手机通道，并把能力上报给服务器。 */
    void kick() {
        try { ContextCompat.startForegroundService(activity, new Intent(activity, PushService.class)); } catch (Exception ignored) { }
    }
}

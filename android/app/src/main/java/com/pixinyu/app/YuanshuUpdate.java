package com.pixinyu.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONObject;

/**
 * 手机端新版本（window.YuanshuUpdate，2026-11-20）：
 *   version()   本 App 的版本号，页面拿它和 /api/app/latest 比
 *   install()   从电脑下载最新 APK（能直连就走直连，快得多）并交给系统安装器；
 *               进度通过 yuanshu-update 事件回给页面：{state: downloading|installing|failed, percent, error}
 */
public class YuanshuUpdate {
    private final Activity activity;
    private WebView webView;
    private volatile boolean busy = false;

    YuanshuUpdate(Activity activity) { this.activity = activity; }

    void attach(WebView view) { webView = view; }

    @JavascriptInterface
    public String version() {
        try { return activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName; }
        catch (Exception e) { return ""; }
    }

    @JavascriptInterface
    public void install() {
        if (busy) return;
        // 系统要求：每个来源第一次装 APK 前，用户在设置里允许「安装未知应用」
        if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
            emit("failed", 0, "先允许元枢「安装未知应用」，回来再点一次更新");
            activity.runOnUiThread(() -> {
                try { activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.getPackageName()))); }
                catch (Exception ignored) { }
            });
            return;
        }
        busy = true;
        new Thread(this::download, "yuanshu-update").start();
    }

    private void download() {
        SharedPreferences prefs = activity.getSharedPreferences(PushService.PREFS, Context.MODE_PRIVATE);
        String base = prefs.getString("baseUrl", ""), token = prefs.getString("token", "");
        File out = new File(activity.getCacheDir(), "update.apk");
        try {
            if (base.isEmpty() || token.isEmpty()) throw new IllegalStateException("还没登录，拿不到安装包");
            String via = Routes.pick(activity, base, token);
            HttpURLConnection c;
            try { c = open(via, token); }
            catch (Exception direct) { if (via.equals(base)) throw direct; Routes.invalidate(); c = open(base, token); }
            long total = c.getContentLengthLong(), done = 0;
            int last = -1;
            try (InputStream in = c.getInputStream(); FileOutputStream fo = new FileOutputStream(out)) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) {
                    fo.write(buf, 0, n);
                    done += n;
                    int pct = total > 0 ? (int) (done * 100 / total) : 0;
                    if (pct != last) { last = pct; emit("downloading", pct, ""); }
                }
            } finally { c.disconnect(); }
            if (total > 0 && done != total) throw new IllegalStateException("下载不完整，网络断了，再试一次");
            emit("installing", 100, "");
            Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", out);
            Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.runOnUiThread(() -> activity.startActivity(i));
        } catch (Exception e) {
            emit("failed", 0, e.getMessage() == null ? "下载失败" : e.getMessage());
        } finally { busy = false; }
    }

    private static HttpURLConnection open(String base, String token) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(base + "/api/app/apk").openConnection();
        c.setRequestProperty("Authorization", "Bearer " + token);
        c.setConnectTimeout(8000);
        c.setReadTimeout(30000);
        int code = c.getResponseCode();
        if (code != 200) { c.disconnect(); throw new IllegalStateException("电脑上没找到安装包（" + code + "）"); }
        return c;
    }

    private void emit(String state, int percent, String error) {
        WebView wv = webView;
        if (wv == null) return;
        try {
            String detail = new JSONObject().put("state", state).put("percent", percent).put("error", error).toString();
            wv.post(() -> wv.evaluateJavascript("window.dispatchEvent(new CustomEvent('yuanshu-update',{detail:" + detail + "}))", null));
        } catch (Exception ignored) { }
    }
}

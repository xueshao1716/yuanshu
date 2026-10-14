package com.pixinyu.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONObject;

/** 系统“另存为”选择器：让用户自己决定保存位置，不申请宽泛存储权限。契约与 Tauri 壳的同名桥一致。 */
public class YuanshuDownloads {
    private static final String PREFS = "yuanshu_downloads";
    private final MainActivity activity;
    private WebView webView;
    private DownloadBuffer transfer;
    private boolean waiting = false;
    private boolean copying = false;
    private final ActivityResultLauncher<Intent> picker;

    YuanshuDownloads(MainActivity activity) {
        this.activity = activity;
        this.picker = activity.registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            final DownloadBuffer current;
            synchronized (YuanshuDownloads.this) { current = transfer; }
            if (current == null) return;
            final Uri uri = result.getData() == null ? null : result.getData().getData();
            if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
                release(current);
                emit(current.id, "cancelled", "", "", "");
                return;
            }
            synchronized (YuanshuDownloads.this) { copying = true; }
            new Thread(() -> copyTo(current, uri)).start();
        });
    }

    void attach(WebView view) { webView = view; }

    private void copyTo(DownloadBuffer current, Uri uri) {
        try {
            OutputStream output = activity.getContentResolver().openOutputStream(uri, "w");
            if (output == null) throw new IllegalStateException("无法写入所选位置");
            try (OutputStream target = output; InputStream source = new FileInputStream(current.file)) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = source.read(buf)) > 0) target.write(buf, 0, n);
            }
            try { activity.getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); }
            catch (SecurityException ignored) { }
            SharedPreferences prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            List<String> saved = new ArrayList<>(prefs.getStringSet("saved_uris", new HashSet<>()));
            saved.add(uri.toString());
            if (saved.size() > 80) saved = saved.subList(saved.size() - 80, saved.size());
            prefs.edit().putStringSet("saved_uris", new HashSet<>(saved)).apply();
            String displayName = current.name;
            try (Cursor cursor = activity.getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst() && cursor.getString(0) != null) displayName = cursor.getString(0);
            } catch (Exception ignored) { /* 文件已保存，拿不到显示名不影响结果 */ }
            release(current);
            emit(current.id, "saved", uri.toString(), "系统所选位置 · " + displayName, "");
        } catch (Exception error) {
            try { DocumentsContract.deleteDocument(activity.getContentResolver(), uri); } catch (Exception ignored) { }
            release(current);
            emit(current.id, "failed", "", "", error.getMessage() == null ? "文件保存失败" : error.getMessage());
        }
    }

    @JavascriptInterface
    public synchronized String begin(String id, String name, String mime, long size) {
        if (transfer != null && !waiting && !copying && System.currentTimeMillis() - transfer.lastTouched() > 120000) release(transfer);
        if (transfer != null) return "请先完成当前文件的保存";
        try {
            String safeMime = mime != null && mime.matches("[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+") ? mime : "application/octet-stream";
            transfer = new DownloadBuffer(activity.getCacheDir(), id, name, safeMime, size);
            return "";
        } catch (Exception error) { return error.getMessage() == null ? "无法准备下载文件" : error.getMessage(); }
    }

    @JavascriptInterface
    public synchronized String append(String id, String base64) {
        try {
            DownloadBuffer current = transfer;
            if (current == null || !current.id.equals(id) || waiting) throw new IllegalStateException("下载已失效，请重试");
            if (base64.length() > 87384) throw new IllegalArgumentException("下载分块过大");
            current.append(Base64.decode(base64, Base64.NO_WRAP));
            return "";
        } catch (Exception error) { return error.getMessage() == null ? "无法保存下载数据" : error.getMessage(); }
    }

    @JavascriptInterface
    public synchronized String finish(String id) {
        try {
            final DownloadBuffer current = transfer;
            if (current == null || !current.id.equals(id) || waiting) throw new IllegalStateException("下载已失效，请重试");
            current.finish();
            waiting = true;
            activity.runOnUiThread(() -> {
                try {
                    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType(current.mime);
                    intent.putExtra(Intent.EXTRA_TITLE, current.name);
                    picker.launch(intent);
                } catch (Exception error) {
                    release(current);
                    emit(id, "failed", "", "", error.getMessage() == null ? "无法打开系统保存窗口" : error.getMessage());
                }
            });
            return "";
        } catch (Exception error) { return error.getMessage() == null ? "无法保存文件" : error.getMessage(); }
    }

    @JavascriptInterface
    public synchronized void cancel(String id) {
        if (transfer != null && transfer.id.equals(id) && !waiting) release(transfer);
    }

    @JavascriptInterface
    public String openSaved(String value) {
        try {
            Set<String> saved = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getStringSet("saved_uris", new HashSet<>());
            if (value == null || !saved.contains(value)) return "记录已失效，请在系统文件管理器中打开，或重新下载";
            Uri uri = Uri.parse(value);
            String type = activity.getContentResolver().getType(uri);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, type == null ? "application/octet-stream" : type);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            activity.startActivity(intent);
            return "";
        } catch (ActivityNotFoundException e) {
            return "手机上没有支持此文件类型的应用";
        } catch (Exception error) {
            return error.getMessage() == null ? "无法打开文件，请在系统文件管理器中查看" : error.getMessage();
        }
    }

    private synchronized void release(DownloadBuffer current) {
        try { current.close(); } catch (Exception ignored) { }
        if (transfer == current) { transfer = null; waiting = false; copying = false; }
    }

    synchronized void dispose() {
        webView = null;
        if (!copying && transfer != null) release(transfer);
    }

    private void emit(String id, String status, String uri, String location, String error) {
        try {
            final JSONObject payload = new JSONObject().put("id", id).put("status", status).put("uri", uri)
                .put("location", location).put("error", error);
            activity.runOnUiThread(() -> {
                if (webView != null) webView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('yuanshu-download-result',{detail:" + payload + "}))", null);
            });
        } catch (Exception ignored) { }
    }
}

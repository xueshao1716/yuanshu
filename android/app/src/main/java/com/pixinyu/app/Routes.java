package com.pixinyu.app;

import android.content.Context;
import android.content.SharedPreferences;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 选路（2026-11-20）：登录用的域名走 Cloudflare 隧道，绕海外一圈，一次往返 1~2 秒。
 * 手机和电脑在同一个 Wi-Fi，或手机装了 Tailscale 时，可以直接连电脑（几毫秒）。
 *   1. 经域名取 /api/net/reachability，记下电脑的 Tailscale / 局域网地址；
 *   2. 逐个试：GET /api/net/hello?kid&nonce，对方要用令牌哈希算出 HMAC 证明，对得上才算「是这台元枢」，
 *      这一步不发令牌（换了 Wi-Fi 碰上同网段别人的机器，拿不到令牌）；
 *   3. 第一个通过的就用它；都不通用域名。网络变化、连续失败或 3 分钟后重选。
 */
final class Routes {
    private static volatile String chosen = "";
    private static volatile String chosenFor = "";
    private static volatile long chosenAt = 0;
    private static volatile String label = "域名";

    private Routes() { }

    static String label() { return label; }

    /** 当前该用的地址（可能阻塞几秒做探测，别在主线程调）。 */
    static synchronized String pick(Context ctx, String base, String token) {
        long now = System.currentTimeMillis();
        if (base.equals(chosenFor) && !chosen.isEmpty() && now - chosenAt < 180_000) return chosen;
        String best = base;
        String how = "域名";
        for (String cand : candidates(ctx, base, token)) {
            if (verify(cand, token)) { best = cand; how = cand.contains("//100.") ? "Tailscale 直连" : "局域网直连"; break; }
        }
        chosen = best; chosenFor = base; chosenAt = now; label = how;
        return best;
    }

    /** 不探测，只看现成结果：没选过或已过期返回 null。 */
    static String peek(String base) {
        return base.equals(chosenFor) && !chosen.isEmpty() && System.currentTimeMillis() - chosenAt < 180_000 ? chosen : null;
    }

    /** 直连出错：下次重新选（直连地址失效时很快回到域名）。 */
    static void invalidate() { chosenAt = 0; }

    private static List<String> candidates(Context ctx, String base, String token) {
        SharedPreferences p = ctx.getSharedPreferences(PushService.PREFS, Context.MODE_PRIVATE);
        String cached = p.getString("directUrls", "[]");
        long fetchedAt = p.getLong("directUrlsAt", 0);
        if (System.currentTimeMillis() - fetchedAt > 600_000) {
            try {
                JSONObject r = new JSONObject(get(base + "/api/net/reachability", token, 8000));
                JSONArray out = new JSONArray();
                for (String k : new String[]{"tailscale", "ipv4"}) {
                    JSONArray arr = r.optJSONArray(k);
                    for (int i = 0; arr != null && i < arr.length(); i++) {
                        String u = arr.getJSONObject(i).optString("url");
                        if (!u.isEmpty()) out.put(u);
                    }
                }
                cached = out.toString();
                p.edit().putString("directUrls", cached).putLong("directUrlsAt", System.currentTimeMillis()).apply();
            } catch (Exception ignored) { /* 域名都不通就用上次存下的 */ }
        }
        LinkedHashSet<String> list = new LinkedHashSet<>();
        try {
            JSONArray arr = new JSONArray(cached);
            for (int i = 0; i < arr.length() && list.size() < 6; i++) list.add(arr.getString(i).replaceAll("/+$", ""));
        } catch (Exception ignored) { }
        list.remove(base);
        return new ArrayList<>(list);
    }

    private static boolean verify(String cand, String token) {
        try {
            String hash = hex(MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8)));
            byte[] rnd = new byte[16];
            new SecureRandom().nextBytes(rnd);
            String nonce = hex(rnd);
            JSONObject r = new JSONObject(get(cand + "/api/net/hello?kid=" + hash.substring(0, 16) + "&nonce=" + nonce, null, 1500));
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(hash.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return hex(mac.doFinal(nonce.getBytes(StandardCharsets.UTF_8))).equals(r.optString("proof"));
        } catch (Exception e) {
            return false;
        }
    }

    private static String get(String url, String token, int timeoutMs) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(timeoutMs);
        c.setReadTimeout(timeoutMs);
        if (token != null) c.setRequestProperty("Authorization", "Bearer " + token);
        try {
            if (c.getResponseCode() != 200) throw new IllegalStateException("HTTP " + c.getResponseCode());
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
            }
            return sb.toString();
        } finally { c.disconnect(); }
    }

    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }
}

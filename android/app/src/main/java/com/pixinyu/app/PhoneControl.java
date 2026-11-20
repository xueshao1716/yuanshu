package com.pixinyu.app;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 手机控制的能力开关（2026-11-20）。每一项默认关，用户在「手机控制」页里逐项打开；
 * 打开时顺带申请对应的系统权限。上报给服务器的能力 = 开关开着 且 系统权限到位。
 */
public final class PhoneControl {
    static final String PREFS = "yuanshu_phone";

    /** 能力 → 需要的运行时权限（可为空）。顺序即页面上的顺序。 */
    static final Map<String, String[]> CAPS = new LinkedHashMap<>();
    static {
        CAPS.put("apps", new String[]{});
        CAPS.put("clipboard", new String[]{});
        CAPS.put("notifications", new String[]{});
        CAPS.put("location", new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION});
        CAPS.put("calendar", new String[]{Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR});
        CAPS.put("alarm", new String[]{});
        CAPS.put("contacts", new String[]{Manifest.permission.READ_CONTACTS});
        CAPS.put("call", new String[]{Manifest.permission.CALL_PHONE});
        CAPS.put("sms", new String[]{Manifest.permission.SEND_SMS});
        CAPS.put("screen", new String[]{});
    }

    private PhoneControl() { }

    static SharedPreferences prefs(Context c) { return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    static String deviceId(Context c) {
        SharedPreferences p = prefs(c);
        String id = p.getString("deviceId", "");
        if (id.isEmpty()) { id = "and-" + UUID.randomUUID().toString().substring(0, 12); p.edit().putString("deviceId", id).apply(); }
        return id;
    }

    static boolean switchedOn(Context c, String cap) { return prefs(c).getBoolean("cap_" + cap, false); }

    static void setSwitch(Context c, String cap, boolean on) { prefs(c).edit().putBoolean("cap_" + cap, on).apply(); }

    static boolean permitted(Context c, String cap) {
        String[] perms = CAPS.get(cap);
        if (perms == null) return false;
        if (cap.equals("location")) {
            return granted(c, Manifest.permission.ACCESS_FINE_LOCATION) || granted(c, Manifest.permission.ACCESS_COARSE_LOCATION);
        }
        for (String p : perms) if (!granted(c, p)) return false;
        if (cap.equals("screen")) return YuanshuAccess.instance != null;
        if (cap.equals("notifications")) return notificationAccess(c);
        return true;
    }

    static boolean granted(Context c, String perm) { return ContextCompat.checkSelfPermission(c, perm) == PackageManager.PERMISSION_GRANTED; }

    static boolean notificationAccess(Context c) {
        String flat = Settings.Secure.getString(c.getContentResolver(), "enabled_notification_listeners");
        return flat != null && flat.contains(new ComponentName(c, YuanshuNotifs.class).flattenToString());
    }

    /** 开关开着且权限到位的能力。 */
    static List<String> activeCaps(Context c) {
        List<String> out = new ArrayList<>();
        for (String cap : CAPS.keySet()) if (switchedOn(c, cap) && permitted(c, cap)) out.add(cap);
        return out;
    }

    static boolean anyOn(Context c) {
        for (String cap : CAPS.keySet()) if (switchedOn(c, cap)) return true;
        return false;
    }

    static String deviceName() {
        String m = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
        String model = Build.MODEL == null ? "" : Build.MODEL;
        return model.toLowerCase().startsWith(m.toLowerCase()) ? model : (m + " " + model).trim();
    }
}

package com.pixinyu.app;

import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONObject;

/**
 * 悬浮球（2026-11-24 v2.238.0，参考开源 Mika 的「悬浮胶囊」）：
 *   单击 → 问小语卡片；长按 → 打开卡片直接开始说话；双击 → 把当前屏幕的文字一起带给小语（「这条怎么回」）。
 * 用无障碍浮层（TYPE_ACCESSIBILITY_OVERLAY）画，不需要额外的「悬浮窗」权限；只在用户打开开关、且无障碍已启用时出现。
 * 可上下左右拖，松手贴最近的左/右边，位置记住。支付/银行/密码类应用里双击不读屏。
 */
final class YuanshuBubble {
    static final String PREF_ON = "bubble", PREF_X = "bubbleX", PREF_Y = "bubbleY";
    private static final int DOUBLE_TAP_MS = 280;

    private final YuanshuAccess svc;
    private final Handler main = new Handler(Looper.getMainLooper());
    private View view;
    private WindowManager.LayoutParams lp;

    YuanshuBubble(YuanshuAccess svc) { this.svc = svc; }

    static boolean enabled(Context c) { return PhoneControl.prefs(c).getBoolean(PREF_ON, false); }

    /** 按开关显示或收起。 */
    void sync() { if (enabled(svc)) show(); else hide(); }

    boolean shown() { return view != null; }

    /** 截图那一瞬间藏起来（主线程调）。 */
    void setVisible(boolean on) { if (view != null) view.setVisibility(on ? View.VISIBLE : View.INVISIBLE); }

    void show() {
        main.post(() -> {
            if (view != null) return;
            WindowManager wm = (WindowManager) svc.getSystemService(Context.WINDOW_SERVICE);
            float dp = svc.getResources().getDisplayMetrics().density;
            int screenW = svc.getResources().getDisplayMetrics().widthPixels;
            int accent = accent();
            TextView b = new TextView(svc);
            b.setText("语");
            b.setTextColor(Color.WHITE);
            b.setTextSize(15);
            b.setGravity(Gravity.CENTER);
            b.setContentDescription("问小语：点一下提问，长按说话，双击带上当前屏幕");
            GradientDrawable bg = new GradientDrawable();
            bg.setShape(GradientDrawable.OVAL);
            bg.setColor((accent & 0x00FFFFFF) | 0xE0000000);
            bg.setStroke((int) (1.5f * dp), Color.argb(200, 255, 255, 255));
            b.setBackground(bg);
            b.setElevation(6 * dp);
            int size = (int) (44 * dp);
            lp = new WindowManager.LayoutParams(size, size,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT);
            lp.gravity = Gravity.TOP | Gravity.START;
            lp.x = PhoneControl.prefs(svc).getInt(PREF_X, screenW - size - (int) (6 * dp));
            lp.y = PhoneControl.prefs(svc).getInt(PREF_Y, svc.getResources().getDisplayMetrics().heightPixels / 2);
            int slop = (int) (8 * dp);
            b.setOnTouchListener(new View.OnTouchListener() {
                float downX, downY; int startX, startY; boolean moved, longFired; long lastUp;
                final Runnable longPress = () -> { longFired = true; v().performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS); open(true, null); };
                final Runnable singleTap = () -> open(false, null);
                View v() { return view; }
                @Override public boolean onTouch(View v, MotionEvent e) {
                    switch (e.getActionMasked()) {
                        case MotionEvent.ACTION_DOWN:
                            downX = e.getRawX(); downY = e.getRawY(); startX = lp.x; startY = lp.y; moved = false; longFired = false;
                            main.postDelayed(longPress, 450);
                            return true;
                        case MotionEvent.ACTION_MOVE:
                            if (!moved && Math.hypot(e.getRawX() - downX, e.getRawY() - downY) > slop) { moved = true; main.removeCallbacks(longPress); }
                            if (moved) {
                                lp.x = startX + (int) (e.getRawX() - downX);
                                lp.y = Math.max(0, startY + (int) (e.getRawY() - downY));
                                try { wm.updateViewLayout(v, lp); } catch (Exception ignored) { }
                            }
                            return true;
                        case MotionEvent.ACTION_UP:
                        case MotionEvent.ACTION_CANCEL:
                            main.removeCallbacks(longPress);
                            if (moved) {
                                // 松手贴最近的一边，别挡内容
                                int w = svc.getResources().getDisplayMetrics().widthPixels;
                                lp.x = lp.x + size / 2 < w / 2 ? (int) (6 * dp) : w - size - (int) (6 * dp);
                                try { wm.updateViewLayout(v, lp); } catch (Exception ignored) { }
                                PhoneControl.prefs(svc).edit().putInt(PREF_X, lp.x).putInt(PREF_Y, lp.y).apply();
                            } else if (!longFired && e.getActionMasked() == MotionEvent.ACTION_UP) {
                                long now = System.currentTimeMillis();
                                if (now - lastUp < DOUBLE_TAP_MS) { main.removeCallbacks(singleTap); lastUp = 0; withScreen(); }
                                else { lastUp = now; main.postDelayed(singleTap, DOUBLE_TAP_MS); }
                            }
                            return true;
                    }
                    return false;
                }
            });
            try { wm.addView(b, lp); view = b; } catch (Exception ignored) { }
        });
    }

    void hide() {
        main.post(() -> {
            if (view == null) return;
            try { ((WindowManager) svc.getSystemService(Context.WINDOW_SERVICE)).removeView(view); } catch (Exception ignored) { }
            view = null;
        });
    }

    /** 双击：读当前屏幕的文字，交给卡片当这句话的附件。 */
    private void withScreen() {
        new Thread(() -> {
            try {
                JSONObject s = svc.screenText();
                main.post(() -> open(false, s.toString()));
            } catch (Exception e) {
                main.post(() -> Toast.makeText(svc, YuanshuNotifs.clip(e.getMessage(), 60), Toast.LENGTH_SHORT).show());
            }
        }, "bubble-screen").start();
    }

    private void open(boolean voice, String screen) {
        Intent i = new Intent(svc, AssistActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (voice) i.putExtra(AssistActivity.EXTRA_VOICE, true);
        if (screen != null) i.putExtra(AssistActivity.EXTRA_SCREEN, screen);
        try { svc.startActivity(i); } catch (Exception ignored) { }
    }

    /** 跟主程序主题色走（YuanshuFlash 同步过来的）。 */
    private int accent() {
        try {
            JSONObject t = new JSONObject(svc.getSharedPreferences(PushService.PREFS, Context.MODE_PRIVATE).getString(YuanshuFlash.KEY_THEME, ""));
            return Color.parseColor(t.optString("accent", ""));
        } catch (Exception e) { return 0xFF8B7CF6; }
    }
}

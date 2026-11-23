package com.pixinyu.app;

import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/**
 * 2026-11-23 通知栏磁贴「问小语」。
 * 国产 ROM 普遍不让第三方应用当默认数字助理（荣耀绑死 YOYO），长按电源键唤不起来；
 * 磁贴是唯一不依赖 ROM 授权的快速入口：下拉通知栏 → 点一下 → 直接进轻量卡片。
 * 磁贴上不需要常驻状态，点击即跳转，不占资源。
 */
public class AssistTileService extends TileService {
    @Override
    public void onStartListening() {
        super.onStartListening();
        Tile t = getQsTile();
        if (t == null) return;
        t.setLabel(getString(R.string.assist_tile_label));
        t.setState(Tile.STATE_INACTIVE);
        if (Build.VERSION.SDK_INT >= 29) t.setSubtitle("");
        t.updateTile();
    }

    @Override
    public void onClick() {
        super.onClick();
        Intent intent = new Intent(this, AssistActivity.class)
            .setAction(Intent.ACTION_ASSIST)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (isLocked()) {
            // 锁屏状态下先解锁再唤起；unlockAndRun 在 API 24+ 可用
            unlockAndRun(() -> startActivityAndCollapseCompat(intent));
        } else {
            startActivityAndCollapseCompat(intent);
        }
    }

    private void startActivityAndCollapseCompat(Intent intent) {
        if (Build.VERSION.SDK_INT >= 34) {
            PendingIntent pi = PendingIntent.getActivity(this, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            startActivityAndCollapse(pi);
        } else {
            startActivityAndCollapse(intent);
        }
    }
}

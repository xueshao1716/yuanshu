package com.pixinyu.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

/**
 * 2026-11-23 桌面 2×1 卡片「问小语」。
 * 点一下 → ACTION_ASSIST → MainActivity → 前端轻量卡片。桌面入口比长按图标更显眼，
 * 也不依赖 ROM 的助理授权。只做静态卡片，不跑常驻更新，省电。
 */
public class AssistWidgetProvider extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) {
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_assist);
            Intent intent = new Intent(context, MainActivity.class)
                .setAction(Intent.ACTION_ASSIST)
                .putExtra(MainActivity.EXTRA_ASSIST, true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pi = PendingIntent.getActivity(context, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            views.setOnClickPendingIntent(R.id.widget_assist_root, pi);
            views.setOnClickPendingIntent(R.id.widget_assist_mic, pi);
            mgr.updateAppWidget(id, views);
        }
    }
}

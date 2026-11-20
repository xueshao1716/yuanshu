package com.pixinyu.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;

/** 确认弹窗：从通知按钮进来直接给答案；点通知正文进来则弹对话框让用户选。 */
public class ConfirmActivity extends Activity {
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        String id = getIntent().getStringExtra("id");
        String answer = getIntent().getStringExtra("answer");
        Confirmations.Req r = id == null ? null : Confirmations.pending.get(id);
        if (r == null) { finish(); return; }
        if (answer != null) {
            Confirmations.settle(this, id, "allow".equals(answer));
            finish();
            return;
        }
        new AlertDialog.Builder(this)
            .setTitle(r.title)
            .setMessage(r.body)
            .setCancelable(false)
            .setNegativeButton("拒绝", (d, w) -> { Confirmations.settle(this, id, false); finish(); })
            .setPositiveButton("允许", (d, w) -> { Confirmations.settle(this, id, true); finish(); })
            .show();
    }
}

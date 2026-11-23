package com.pixinyu.app;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Outline;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.Base64;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewOutlineProvider;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.FrameLayout;
import android.widget.TextView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.UUID;
import org.json.JSONObject;

/**
 * 问小语浮层（2026-11-23 v2.233.0）。
 *
 * 用户要的是 Gemini 那样的「浮在当前界面上的小卡片」，不是把整个元枢拉到前台：
 * 磁贴 / 桌面卡片 / 长按图标 / 系统助理都打开这个透明 Activity，底部一张卡，
 * 输入或说一句 → 直接在卡里看回答，背后原来的 App 不动。不加载 WebView，所以秒开。
 *
 * 走的接口与网页聊天完全一致：POST /api/sessions 建一个固定的「问小语」会话（id 记在本地），
 * POST /api/runs 发话，GET /api/runs/:id/events 读 SSE 流。说话走 /api/asr（16k 单声道 WAV）。
 * 地址和令牌复用推送服务存的那份（App 里登录过一次就有）。
 */
public class AssistActivity extends Activity {
    private static final String KEY_SESSION = "assistSessionId";
    private static final int REQ_MIC = 3101;
    private static final int RATE = 16000;
    private static final int MAX_REC_MS = 60_000;
    private static final String KEY_POS_X = "assistPosX", KEY_POS_Y = "assistPosY";

    private final Handler ui = new Handler(Looper.getMainLooper());
    private SharedPreferences prefs;
    private EditText input;
    private TextView send, reply, status;
    private ImageView mic;
    private ScrollView replyScroll;
    private View root, sheet, replyBody;
    private LinearLayout images;
    /** 已经放进卡片的图（只在主线程读写）。 */
    private final Set<String> shownImages = new HashSet<>();

    private volatile boolean recording = false;
    private volatile boolean busy = false;
    private volatile HttpURLConnection stream;
    private Thread recThread;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_assist);
        getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE | WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE);
        prefs = getSharedPreferences(PushService.PREFS, Context.MODE_PRIVATE);
        root = findViewById(R.id.assist_scrim);
        sheet = findViewById(R.id.assist_sheet);
        setupFloating();

        input = findViewById(R.id.assist_input);
        send = findViewById(R.id.assist_send);
        reply = findViewById(R.id.assist_reply);
        status = findViewById(R.id.assist_status);
        mic = findViewById(R.id.assist_mic);
        replyScroll = findViewById(R.id.assist_reply_scroll);
        replyBody = findViewById(R.id.assist_reply_body);
        images = findViewById(R.id.assist_images);
        applyTheme();

        findViewById(R.id.assist_scrim).setOnClickListener(v -> finish());
        findViewById(R.id.assist_close).setOnClickListener(v -> finish());
        findViewById(R.id.assist_open_app).setOnClickListener(v -> openApp());
        send.setOnClickListener(v -> submit());
        mic.setOnClickListener(v -> toggleMic());
        input.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
            public void onTextChanged(CharSequence s, int a, int b, int c) { }
            public void afterTextChanged(Editable s) { send.setEnabled(!busy && s.toString().trim().length() > 0); }
        });
        input.setOnEditorActionListener((v, id, ev) -> {
            boolean enter = ev != null && ev.getKeyCode() == KeyEvent.KEYCODE_ENTER && ev.getAction() == KeyEvent.ACTION_DOWN;
            if (id == EditorInfo.IME_ACTION_SEND || enter) { submit(); return true; }
            return false;
        });

        if (base().isEmpty() || token().isEmpty()) {
            showStatus("还没连上元枢：先打开一次元枢 App 并登录，之后这里就能直接用。");
        }
        input.requestFocus();
        // 预热直连选路：第一次可能要几秒，放后台做，这次发话先用域名
        String b = base(), t = token();
        if (!b.isEmpty() && !t.isEmpty() && Routes.peek(b) == null) {
            new Thread(() -> Routes.pick(getApplicationContext(), b, t), "assist-route").start();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        applyTheme();
        input.requestFocus();
    }

    @Override
    protected void onDestroy() {
        recording = false;
        HttpURLConnection c = stream;
        if (c != null) try { c.disconnect(); } catch (Exception ignored) { }
        super.onDestroy();
    }

    // ── 浮动与键盘避让 ───────────────────────────────────────
    //
    // 2026-11-23 v2.234.0：真机反馈「不会浮动、被输入法挡住」。
    // targetSdk 36 下系统强制 edge-to-edge，adjustResize 不再替我们缩窗口——键盘直接盖在卡片上。
    // 所以自己接管：读 IME / 导航栏 / 状态栏 inset 作为根布局内边距，卡片永远在键盘上方；
    // 按住顶部把手或标题栏可以把卡片拖到任意位置（位置记住，下次还在那儿），
    // 键盘弹出把可用区域压扁时，再把卡片夹回可见范围。

    private void setupFloating() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        float dp = getResources().getDisplayMetrics().density;
        int screenW = getResources().getDisplayMetrics().widthPixels;
        // 宽度封顶 440dp：平板/横屏上像一张卡，而不是一条横幅
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) sheet.getLayoutParams();
        lp.width = Math.min(screenW - (int) (20 * dp), (int) (440 * dp));
        lp.gravity = android.view.Gravity.BOTTOM | android.view.Gravity.CENTER_HORIZONTAL;
        sheet.setLayoutParams(lp);

        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, Math.max(ime.bottom, bars.bottom));
            v.post(this::clampSheet);
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(root);

        sheet.setTranslationX(prefs.getFloat(KEY_POS_X, 0f) * dp);
        sheet.setTranslationY(prefs.getFloat(KEY_POS_Y, 0f) * dp);
        // 回答变长、键盘起落都会改尺寸：卡片或根布局一变就重新夹一次
        View.OnLayoutChangeListener reclamp = (v, l, t, r, b, ol, ot, or, ob) -> clampSheet();
        root.addOnLayoutChangeListener(reclamp);
        sheet.addOnLayoutChangeListener(reclamp);

        View.OnTouchListener drag = new View.OnTouchListener() {
            float downX, downY, startTX, startTY;
            boolean moved;
            long lastTap;
            @Override public boolean onTouch(View v, MotionEvent e) {
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = e.getRawX(); downY = e.getRawY();
                        startTX = sheet.getTranslationX(); startTY = sheet.getTranslationY();
                        moved = false;
                        return true;
                    case MotionEvent.ACTION_MOVE: {
                        float dx = e.getRawX() - downX, dy = e.getRawY() - downY;
                        if (!moved && Math.hypot(dx, dy) < 6 * dp) return true;
                        moved = true;
                        sheet.setTranslationX(startTX + dx);
                        sheet.setTranslationY(startTY + dy);
                        clampSheet();
                        return true;
                    }
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        if (moved) {
                            prefs.edit()
                                .putFloat(KEY_POS_X, sheet.getTranslationX() / dp)
                                .putFloat(KEY_POS_Y, sheet.getTranslationY() / dp).apply();
                        } else if (e.getActionMasked() == MotionEvent.ACTION_UP) {
                            long now = System.currentTimeMillis();
                            if (now - lastTap < 320) { resetPosition(); lastTap = 0; } else lastTap = now;
                        }
                        return true;
                }
                return false;
            }
        };
        findViewById(R.id.assist_handle).setOnTouchListener(drag);
        findViewById(R.id.assist_head).setOnTouchListener(drag);
        // 双击标题栏回到默认位置（拖丢了能找回来）——判断写在上面 ACTION_UP 里
    }

    /** 把卡片夹在根布局的内边距（状态栏/键盘/导航栏之间）里，任何时候都整张可见。 */
    private void clampSheet() {
        if (root == null || sheet == null || sheet.getHeight() == 0) return;
        int minLeft = root.getPaddingLeft(), maxRight = root.getWidth() - root.getPaddingRight();
        int minTop = root.getPaddingTop(), maxBottom = root.getHeight() - root.getPaddingBottom();
        float tx = sheet.getTranslationX(), ty = sheet.getTranslationY();
        float left = sheet.getLeft() + tx, top = sheet.getTop() + ty;
        if (left < minLeft) tx += minLeft - left;
        if (left + sheet.getWidth() > maxRight) tx -= left + sheet.getWidth() - maxRight;
        if (top + sheet.getHeight() > maxBottom) ty -= top + sheet.getHeight() - maxBottom;
        top = sheet.getTop() + ty;
        if (top < minTop) ty += minTop - top;   // 卡片比可用高度还高时，优先保证顶部（标题栏）可见
        sheet.setTranslationX(tx);
        sheet.setTranslationY(ty);
    }

    private void resetPosition() {
        prefs.edit().remove(KEY_POS_X).remove(KEY_POS_Y).apply();
        sheet.animate().translationX(0).translationY(0).setDuration(180).withEndAction(this::clampSheet).start();
    }

    // ── 配置 ─────────────────────────────────────────────────

    private String base() { return prefs.getString("baseUrl", ""); }
    private String token() { return prefs.getString("token", ""); }

    private String apiBase() {
        String b = base();
        String direct = Routes.peek(b);
        return direct == null ? b : direct;
    }

    // ── 发话 ─────────────────────────────────────────────────

    private void submit() {
        String text = input.getText().toString().trim();
        if (text.isEmpty() || busy) return;
        if (base().isEmpty() || token().isEmpty()) { showStatus("还没连上元枢：先打开一次元枢 App 并登录。"); return; }
        if (recording) stopRecording(false);
        busy = true;
        send.setEnabled(false);
        input.setText("");
        hideKeyboard();
        replyScroll.setVisibility(View.VISIBLE);
        reply.setText("");
        images.removeAllViews();
        images.setVisibility(View.GONE);
        shownImages.clear();
        showStatus("「" + clip(text, 40) + "」 · 正在想…");
        new Thread(() -> runChat(text), "assist-chat").start();
    }

    private void runChat(String text) {
        try {
            String sid = ensureSession();
            JSONObject body = new JSONObject()
                .put("sessionId", sid)
                .put("clientRequestId", "assist-" + UUID.randomUUID())
                .put("message", text)
                .put("stream", true);
            JSONObject created;
            try {
                created = post("/api/runs", body, 30_000);
            } catch (HttpError e) {
                if (e.code == 409) {
                    // 上一句还在跑：换个新会话，不让用户等
                    prefs.edit().remove(KEY_SESSION).apply();
                    body.put("sessionId", ensureSession());
                    created = post("/api/runs", body, 30_000);
                } else throw e;
            }
            readStream(created.getString("runId"));
        } catch (Exception e) {
            ui.post(() -> showStatus("没发出去：" + friendly(e)));
        } finally {
            busy = false;
            ui.post(() -> send.setEnabled(input.getText().toString().trim().length() > 0));
        }
    }

    private String ensureSession() throws Exception {
        String sid = prefs.getString(KEY_SESSION, "");
        if (!sid.isEmpty()) return sid;
        JSONObject d = post("/api/sessions", new JSONObject().put("name", "问小语"), 15_000);
        sid = d.getString("id");
        prefs.edit().putString(KEY_SESSION, sid).apply();
        return sid;
    }

    private void readStream(String runId) throws Exception {
        StringBuilder acc = new StringBuilder();
        long after = 0;
        boolean finished = false;
        for (int attempt = 0; attempt < 6 && !finished && !isFinishing(); attempt++) {
            HttpURLConnection c = open("/api/runs/" + runId + "/events?after=" + after, "GET", 0);
            c.setRequestProperty("Accept", "text/event-stream");
            c.setRequestProperty("Last-Event-ID", String.valueOf(after));
            stream = c;
            try {
                if (c.getResponseCode() >= 400) throw new HttpError(c.getResponseCode(), "");
                BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
                StringBuilder data = new StringBuilder();
                String line;
                while ((line = r.readLine()) != null) {
                    if (line.startsWith("data:")) { data.append(line.substring(5).trim()); continue; }
                    if (!line.isEmpty() || data.length() == 0) continue;
                    JSONObject ev;
                    try { ev = new JSONObject(data.toString()); } catch (Exception bad) { data.setLength(0); continue; }
                    data.setLength(0);
                    long seq = ev.optLong("seq", 0);
                    if (seq <= after) continue;
                    after = seq;
                    if (handleEvent(ev, acc)) { finished = true; break; }
                }
            } catch (Exception e) {
                if (isFinishing()) return;
                if (attempt == 5) throw e;
            } finally {
                try { c.disconnect(); } catch (Exception ignored) { }
                stream = null;
            }
            if (!finished) Thread.sleep(1200);
        }
    }

    /** 返回 true 表示本轮结束。 */
    private boolean handleEvent(JSONObject ev, StringBuilder acc) {
        String type = ev.optString("type");
        JSONObject d = ev.optJSONObject("data");
        if (d == null) d = new JSONObject();
        switch (type) {
            case "delta":
            case "message": {
                String t = d.optString("text", "");
                if (t.isEmpty()) { JSONObject dd = d.optJSONObject("delta"); if (dd != null) t = dd.optString("text", ""); }
                if (!t.isEmpty()) { acc.append(t); String snap = plain(acc.toString()); ui.post(() -> showReply(snap)); postImages(acc.toString()); }
                return false;
            }
            case "response_replace": {
                String t = d.optString("text", "");
                if (!t.isEmpty()) { acc.setLength(0); acc.append(t); String snap = plain(t); ui.post(() -> showReply(snap)); postImages(t); }
                return false;
            }
            case "tool": {
                String name = d.optString("label", d.optString("name", d.optString("toolName", "")));
                ui.post(() -> showStatus(name.isEmpty() ? "正在处理…" : "正在用 " + name + "…"));
                postImages(unslash(d.toString()));   // 出图工具的输出里就带图片地址
                return false;
            }
            case "confirm":
                ui.post(() -> showStatus("这一步需要你确认，点「打开元枢」去处理。"));
                return false;
            case "error": {
                String m = d.optString("message", d.optString("error", "出错了"));
                ui.post(() -> showStatus(m));
                return false;
            }
            case "completed":
            case "failed":
            case "stopped":
            case "interrupted": {
                boolean ok = !"failed".equals(type) && !"stopped".equals(type) && !"interrupted".equals(type);
                postImages(unslash(d.toString()));
                ui.post(() -> {
                    if (ok) hideStatus();
                    else showStatus("failed".equals(type) ? "这次没答上来，可以点「打开元枢」看详情。" : "已停止。");
                    if (ok && acc.length() == 0 && shownImages.isEmpty()) showStatus("做完了（没有文字回复，去元枢里看结果）。");
                    input.requestFocus();
                });
                return true;
            }
            default:
                return false;
        }
    }

    // ── 说话 ─────────────────────────────────────────────────

    private void toggleMic() {
        if (recording) { stopRecording(true); return; }
        if (busy) return;
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
            return;
        }
        startRecording();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code != REQ_MIC) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) startRecording();
        else showStatus("没有麦克风权限，可以直接打字。");
    }

    private void startRecording() {
        int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        AudioRecord rec;
        try {
            rec = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT, Math.max(min, RATE));
            if (rec.getState() != AudioRecord.STATE_INITIALIZED) throw new IllegalStateException("麦克风被占用");
            rec.startRecording();
        } catch (Exception e) {
            showStatus("打不开麦克风：" + friendly(e));
            return;
        }
        recording = true;
        mic.setSelected(true);
        hideKeyboard();
        final long started = System.currentTimeMillis();
        showStatus("正在听…（再点一下结束）");
        recThread = new Thread(() -> {
            ByteArrayOutputStream pcm = new ByteArrayOutputStream();
            byte[] buf = new byte[Math.max(min, 3200)];
            boolean keep = true;
            try {
                while (recording) {
                    int n = rec.read(buf, 0, buf.length);
                    if (n > 0) pcm.write(buf, 0, n);
                    long ms = System.currentTimeMillis() - started;
                    if (ms > MAX_REC_MS) { recording = false; break; }
                    if (ms / 1000 != (ms - 100) / 1000) { long s = ms / 1000; ui.post(() -> { if (recording) showStatus("正在听… " + s + "s（再点一下结束）"); }); }
                }
                keep = !cancelRec;
            } finally {
                try { rec.stop(); } catch (Exception ignored) { }
                rec.release();
            }
            ui.post(() -> mic.setSelected(false));
            if (!keep || pcm.size() < RATE / 2) { ui.post(() -> { if (!cancelRec) showStatus("太短了，再说一次？"); }); return; }
            transcribe(pcm.toByteArray());
        }, "assist-rec");
        cancelRec = false;
        recThread.start();
    }

    private volatile boolean cancelRec = false;

    private void stopRecording(boolean keep) {
        cancelRec = !keep;
        recording = false;
    }

    private void transcribe(byte[] pcm) {
        ui.post(() -> showStatus("正在识别…"));
        try {
            String b64 = Base64.encodeToString(wav(pcm), Base64.NO_WRAP);
            JSONObject r = post("/api/asr", new JSONObject().put("data", b64).put("format", "wav"), 130_000);
            String text = r.optString("text", "").trim();
            ui.post(() -> {
                if (text.isEmpty()) { showStatus("没听清，再说一次？"); return; }
                String cur = input.getText().toString();
                input.setText(cur.isEmpty() ? text : cur + " " + text);
                input.setSelection(input.getText().length());
                hideStatus();
                // 说完就发：语音入口的人不想再点一下
                submit();
            });
        } catch (Exception e) {
            ui.post(() -> showStatus("语音识别失败：" + friendly(e)));
        }
    }

    private static byte[] wav(byte[] pcm) {
        ByteBuffer h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
        h.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + pcm.length).put("WAVE".getBytes(StandardCharsets.US_ASCII));
        h.put("fmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1).putShort((short) 1)
            .putInt(RATE).putInt(RATE * 2).putShort((short) 2).putShort((short) 16);
        h.put("data".getBytes(StandardCharsets.US_ASCII)).putInt(pcm.length);
        byte[] out = new byte[44 + pcm.length];
        System.arraycopy(h.array(), 0, out, 0, 44);
        System.arraycopy(pcm, 0, out, 44, pcm.length);
        return out;
    }

    // ── HTTP ─────────────────────────────────────────────────

    private static final class HttpError extends Exception {
        final int code;
        HttpError(int code, String body) { super("HTTP " + code + (body.isEmpty() ? "" : " " + clip(body, 120))); this.code = code; }
    }

    private HttpURLConnection open(String path, String method, int timeoutMs) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(apiBase() + path).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(10_000);
        c.setReadTimeout(timeoutMs);
        c.setRequestProperty("Authorization", "Bearer " + token());
        return c;
    }

    private JSONObject post(String path, JSONObject body, int timeoutMs) throws Exception {
        HttpURLConnection c;
        try {
            c = open(path, "POST", timeoutMs);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            try (OutputStream o = c.getOutputStream()) { o.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
            c.getResponseCode();
        } catch (java.io.IOException e) {
            // 直连地址失效：作废，下一次回到域名
            Routes.invalidate();
            c = (HttpURLConnection) new URL(base() + path).openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(10_000);
            c.setReadTimeout(timeoutMs);
            c.setRequestProperty("Authorization", "Bearer " + token());
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            try (OutputStream o = c.getOutputStream()) { o.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
        }
        int code = c.getResponseCode();
        String text = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream());
        c.disconnect();
        if (code >= 400) throw new HttpError(code, text);
        return text.isEmpty() ? new JSONObject() : new JSONObject(text);
    }

    private static String readAll(java.io.InputStream in) throws Exception {
        if (in == null) return "";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] b = new byte[8192];
        int n;
        while ((n = in.read(b)) > 0) out.write(b, 0, n);
        in.close();
        return out.toString("UTF-8");
    }

    // ── 回答里的图 ───────────────────────────────────────────
    //
    // 2026-11-23 v2.235.0：真机反馈「卡片上让她画图了，没有展示出来」。
    // 出的图在回答里是 ![图片](/api/ws/file?path=…png&exp=…&sig=…)，以前 plain() 直接换成「[图片]」字样。
    // 现在从回答正文和出图工具的输出里把图片地址捞出来，下载后缩到卡片宽度，显示在文字下面。

    private static final Pattern MD_IMAGE = Pattern.compile("!\\[[^\\]]*\\]\\(([^)\\s]+)\\)");
    private static final Pattern WS_FILE = Pattern.compile("/api/ws/file\\?[^\\s\"'<>)\\]（）]+");
    private static final Pattern IMAGE_EXT = Pattern.compile("(?i)\\.(png|jpe?g|webp|gif|bmp)$");

    private static String unslash(String json) { return json.replace("\\/", "/"); }

    /** 后台线程调用：找出新出现的图片地址，交给主线程加载。 */
    private void postImages(String text) {
        List<String> found = new ArrayList<>();
        Matcher m = MD_IMAGE.matcher(text);
        while (m.find()) found.add(m.group(1));
        m = WS_FILE.matcher(text);
        while (m.find()) if (isImagePath(m.group())) found.add(m.group());
        if (!found.isEmpty()) ui.post(() -> { for (String u : found) addImage(u); });
    }

    private static String pathParam(String url) {
        int q = url.indexOf("path=");
        if (q < 0) return null;
        String p = url.substring(q + 5);
        int amp = p.indexOf('&');
        return amp >= 0 ? p.substring(0, amp) : p;
    }

    private static boolean isImagePath(String url) {
        String p = pathParam(url);
        if (p == null) return false;
        try { p = java.net.URLDecoder.decode(p, "UTF-8"); } catch (Exception ignored) { }
        return IMAGE_EXT.matcher(p).find();
    }

    private void addImage(String url) {
        // 同一张图去重：文件路径一样就算同一张（签名参数每次可能不同）
        String key = pathParam(url);
        if (isFinishing() || !shownImages.add(key == null ? url : key)) return;
        int width = Math.max(replyScroll.getWidth(), (int) (240 * getResources().getDisplayMetrics().density));
        new Thread(() -> {
            Bitmap bmp = null;
            try { bmp = fetchBitmap(url, width); } catch (Exception ignored) { }
            Bitmap shown = bmp;
            ui.post(() -> {
                if (isFinishing()) return;
                if (shown == null) showStatus("图已画好，但卡片里没加载出来，点「打开元枢」看。");
                else showImage(shown);
            });
        }, "assist-image").start();
    }

    private Bitmap fetchBitmap(String url, int maxWidth) throws Exception {
        HttpURLConnection c;
        if (url.startsWith("/")) c = open(url, "GET", 30_000);
        else { c = (HttpURLConnection) new URL(url).openConnection(); c.setConnectTimeout(10_000); c.setReadTimeout(30_000); }
        byte[] bytes;
        try {
            if (c.getResponseCode() >= 400) throw new HttpError(c.getResponseCode(), "");
            java.io.InputStream in = c.getInputStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] b = new byte[16384];
            int n;
            while ((n = in.read(b)) > 0) {
                out.write(b, 0, n);
                if (out.size() > 25 * 1024 * 1024) throw new IllegalStateException("图片太大");
            }
            in.close();
            bytes = out.toByteArray();
        } finally {
            c.disconnect();
        }
        // 先只读尺寸，按卡片宽度算缩小倍数，免得大图把内存撑爆
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, o);
        int sample = 1;
        while (o.outWidth / (sample * 2) >= maxWidth) sample *= 2;
        o = new BitmapFactory.Options();
        o.inSampleSize = sample;
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.length, o);
    }

    private void showImage(Bitmap bmp) {
        float dp = getResources().getDisplayMetrics().density;
        ImageView iv = new ImageView(this);
        iv.setAdjustViewBounds(true);
        iv.setScaleType(ImageView.ScaleType.FIT_CENTER);
        iv.setImageBitmap(bmp);
        iv.setOutlineProvider(new ViewOutlineProvider() {
            @Override public void getOutline(View v, Outline o) { o.setRoundRect(0, 0, v.getWidth(), v.getHeight(), 12 * dp); }
        });
        iv.setClipToOutline(true);
        iv.setContentDescription("回答里的图片");
        iv.setOnClickListener(v -> openApp());   // 点图去元枢里看大图、保存、分享
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = (int) (8 * dp);
        images.addView(iv, lp);
        images.setVisibility(View.VISIBLE);
        replyScroll.setVisibility(View.VISIBLE);
        if (status.getText().toString().startsWith("做完了")) hideStatus();
        fitReply();
    }

    // ── 主题：跟主程序同色 ───────────────────────────────────
    //
    // 2026-11-23 v2.235.0：主程序每次换主题都通过 YuanshuFlash.setTheme 存一份关键颜色（#AARRGGBB），
    // 卡片打开时按它重新上色。没存过（还没用新版主程序打开过）就保持布局里的默认深色。

    private void applyTheme() {
        JSONObject t;
        try { t = new JSONObject(prefs.getString(YuanshuFlash.KEY_THEME, "")); } catch (Exception e) { return; }
        float dp = getResources().getDisplayMetrics().density;
        int text = color(t, "text", 0xFFF2F5F8);
        int dim = color(t, "dim", 0xFF8A94A1);
        int accent = color(t, "accent", 0xFF8B7CF6);
        int onAccent = color(t, "onAccent", 0xFFFFFFFF);
        // 卡片浮在别的 App 上，底色必须不透明：玻璃类主题的半透明面板色先垫一层深/浅底
        int bg = solid(color(t, "bg", 0xFF161B21), luminance(text) > 0.5 ? 0xFF101317 : 0xFFFAFAFA);
        int field = solid(color(t, "field", bg), bg);
        int btn = solid(color(t, "btn", field), bg);

        sheet.setBackground(shape(bg, 22 * dp, color(t, "border", 0x26FFFFFF), dp));
        input.setBackground(shape(field, 14 * dp, color(t, "fieldBorder", 0x1FFFFFFF), dp));
        input.setTextColor(text);
        input.setHintTextColor(withAlpha(dim, 0xB0));
        input.setHighlightColor(withAlpha(accent, 0x55));
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            GradientDrawable cursor = new GradientDrawable();
            cursor.setColor(accent);
            cursor.setSize((int) (2 * dp), (int) (20 * dp));
            input.setTextCursorDrawable(cursor);
        }
        ((TextView) findViewById(R.id.assist_title)).setTextColor(text);
        reply.setTextColor(text);
        reply.setHighlightColor(withAlpha(accent, 0x55));
        status.setTextColor(dim);
        ((TextView) findViewById(R.id.assist_open_app)).setTextColor(dim);
        ((TextView) findViewById(R.id.assist_close)).setTextColor(dim);
        findViewById(R.id.assist_handle).setBackground(shape(withAlpha(dim, 0x80), 2 * dp, 0, 0));

        StateListDrawable sendBg = new StateListDrawable();
        sendBg.addState(new int[]{-android.R.attr.state_enabled}, shape(withAlpha(accent, 0x40), 22 * dp, 0, 0));
        sendBg.addState(new int[]{}, shape(accent, 22 * dp, 0, 0));
        send.setBackground(sendBg);
        send.setTextColor(new ColorStateList(
            new int[][]{{-android.R.attr.state_enabled}, {}},
            new int[]{withAlpha(onAccent, 0x99), onAccent}));

        GradientDrawable micOn = new GradientDrawable();
        micOn.setShape(GradientDrawable.OVAL);
        micOn.setColor(color(t, "danger", 0xFFE5484D));
        GradientDrawable micOff = new GradientDrawable();
        micOff.setShape(GradientDrawable.OVAL);
        micOff.setColor(btn);
        StateListDrawable micBg = new StateListDrawable();
        micBg.addState(new int[]{android.R.attr.state_selected}, micOn);
        micBg.addState(new int[]{}, micOff);
        mic.setBackground(micBg);
        mic.setImageTintList(new ColorStateList(
            new int[][]{{android.R.attr.state_selected}, {}},
            new int[]{0xFFFFFFFF, text}));
    }

    private static int color(JSONObject t, String key, int fallback) {
        try { return Color.parseColor(t.optString(key, "")); } catch (Exception e) { return fallback; }
    }

    private static int withAlpha(int c, int a) { return (c & 0x00FFFFFF) | (a << 24); }

    private static double luminance(int c) {
        return (0.299 * Color.red(c) + 0.587 * Color.green(c) + 0.114 * Color.blue(c)) / 255.0;
    }

    /** 半透明颜色铺到不透明底色上，得到实色。 */
    private static int solid(int c, int under) {
        float a = Color.alpha(c) / 255f;
        if (a >= 0.99f) return c | 0xFF000000;
        return Color.rgb(
            Math.round(Color.red(c) * a + Color.red(under) * (1 - a)),
            Math.round(Color.green(c) * a + Color.green(under) * (1 - a)),
            Math.round(Color.blue(c) * a + Color.blue(under) * (1 - a)));
    }

    private static GradientDrawable shape(int fill, float radius, int stroke, float dp) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(radius);
        if (stroke != 0 && dp > 0) g.setStroke(Math.max(1, (int) dp), stroke);
        return g;
    }

    // ── 界面小工具 ───────────────────────────────────────────

    private void showReply(String text) {
        replyScroll.setVisibility(View.VISIBLE);
        reply.setText(text);
        fitReply();
        hideStatus();
    }

    /** 回答太长时卡片别顶满屏：滚动区（文字 + 图）封顶约 45% 屏高。 */
    private void fitReply() {
        int cap = (int) (getResources().getDisplayMetrics().heightPixels * 0.45f);
        replyBody.post(() -> {
            ViewGroup.LayoutParams lp = replyScroll.getLayoutParams();
            int want = replyBody.getHeight() > cap ? cap : ViewGroup.LayoutParams.WRAP_CONTENT;
            if (lp.height != want) { lp.height = want; replyScroll.setLayoutParams(lp); }
            replyScroll.fullScroll(View.FOCUS_DOWN);
        });
    }

    private void showStatus(String s) { status.setText(s); status.setVisibility(View.VISIBLE); }
    private void hideStatus() { status.setVisibility(View.GONE); }

    private void hideKeyboard() {
        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (imm != null) imm.hideSoftInputFromWindow(input.getWindowToken(), 0);
    }

    private void openApp() {
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        String sid = prefs.getString(KEY_SESSION, "");
        if (!sid.isEmpty()) i.putExtra(MainActivity.EXTRA_OPEN_SESSION, sid);
        startActivity(i);
        finish();
    }

    /** 卡片里放的是纯文本：去掉最常见的 Markdown 记号，免得满屏星号井号。 */
    private static String plain(String md) {
        return md.replaceAll("(?m)^#{1,6}\\s*", "")
            .replace("**", "")
            .replaceAll("(?m)^```.*$", "")
            .replaceAll("`([^`]+)`", "$1")
            .replaceAll("!\\[[^\\]]*\\]\\([^)]*\\)", "")   // 图在文字下面单独显示
            .replaceAll("\\[([^\\]]+)\\]\\([^)]*\\)", "$1")
            .trim();
    }

    private static String clip(String s, int n) { return s.length() <= n ? s : s.substring(0, n) + "…"; }

    private static String friendly(Exception e) {
        if (e instanceof HttpError) {
            int code = ((HttpError) e).code;
            if (code == 401) return "登录已失效，打开元枢重新登录一次。";
            if (code == 409) return "上一句还在处理中，稍等。";
            return e.getMessage();
        }
        if (e instanceof java.net.UnknownHostException || e instanceof java.net.ConnectException) return "连不上电脑上的元枢，看看电脑开着没有。";
        if (e instanceof java.net.SocketTimeoutException) return "等太久没回应，稍后再试。";
        String m = e.getMessage();
        return m == null ? e.getClass().getSimpleName() : m;
    }
}
